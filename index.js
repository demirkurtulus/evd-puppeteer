import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-core";
import { google } from "googleapis";
import PQueue from "p-queue";
import otplib from "otplib";

const app = express();
app.use(express.json());

// Basit API key koruması (opsiyonel ama önerilir)
app.use((req, res, next) => {
  if (process.env.API_KEY && req.headers["x-api-key"] !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
});

const UPLOAD_DIR = "/app/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Hesap konfigleri (env: ACCOUNTS_JSON_B64)
// Örnek: { "evd_main": { "email":"...", "password":"...", "totpSecret":"..." } }
const ACCOUNTS = JSON.parse(
  Buffer.from(process.env.ACCOUNTS_JSON_B64, "base64").toString("utf8")
);

// Hesap başına tek kuyruk (aynı anda tek oturum)
const queues = new Map();
function getQueue(key) {
  if (!queues.has(key)) queues.set(key, new PQueue({ concurrency: 1 }));
  return queues.get(key);
}

// ---- Google Drive (service account ile) ----
async function driveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.DRIVE_SA_JSON || "/app/creds/service-account.json",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"]
  });
  return google.drive({ version: "v3", auth });
}
async function downloadFromDrive(fileId, destPath) {
  const drive = await driveClient();
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    res.data.on("end", resolve).on("error", reject).pipe(dest);
  });
  return destPath;
}

async function robustLogin(browser, account) {
  // Aktif sayfayı yönetebilmek için helper
  const getActivePage = async () => {
    const pages = await browser.pages();
    return pages[pages.length - 1];
  };

  let page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7" });
  await page.setViewport({ width: 1280, height: 800 });
  page.setDefaultTimeout(30000);

  // Yeni hedef açılırsa ona geç
  const onTargetCreated = async (target) => {
    try {
      if (target.type() === "page") {
        const newPage = await target.page();
        // bazen boş/arka plan açılıyor; URL yüklendiyse geç
        const url = newPage.url();
        if (url && !url.startsWith("about:blank")) {
          page = newPage;
        }
      }
    } catch {}
  };
  browser.on("targetcreated", onTargetCreated);

  // Giriş sayfasına git (business'a devam parametresi ile)
  await page.goto("https://accounts.google.com/signin/v2/identifier?service=business&hl=tr&continue=https://business.google.com/", { waitUntil: "domcontentloaded" });

  // 1) E-posta
  await page.waitForSelector('input[type="email"], input[name="identifier"]', { visible: true });
  await page.type('input[type="email"], input[name="identifier"]', account.email, { delay: 20 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}), // bazen tam nav olmuyor
    page.click('#identifierNext'),
  ]);

  // 2) Şifre alanını çeşitli selector’larla ara
  async function waitForPasswordField() {
    const selectors = [
      'input[name="Passwd"]',
      'input[type="password"]',
      'input[aria-label="Şifre"]',
      'input[autocomplete="current-password"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) return sel;
    }
    // gelmediyse biraz bekleyip tekrar dene
    await page.waitForTimeout(1500);
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) return sel;
    }
    return null;
  }

  // Bazı hesaplarda önce "Hesabı seç" ekranı çıkabilir
  const accountChooser = await page.$('div[role="button"][data-identifier], div[data-identifier]');
  if (accountChooser) {
    // eposta ile eşleşeni bul
    const buttons = await page.$$('[data-identifier]');
    for (const b of buttons) {
      const v = await b.evaluate((el) => el.getAttribute("data-identifier"));
      if (v === account.email) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
          b.click(),
        ]);
        break;
      }
    }
  }

  // Şifre
  let passSel = await waitForPasswordField();
  if (!passSel) {
    // bazen tekrar e-posta sorup sonra şifreye geçiyor; sayfayı bekletip yeniden dene
    await page.waitForTimeout(2000);
    passSel = await waitForPasswordField();
  }
  if (!passSel) {
    // consent / continue ekranı olabilir
    const contBtn = await page.$('button:has-text("Devam"), div[role="button"]:has-text("Devam")');
    if (contBtn) {
      await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}), contBtn.click()]);
      passSel = await waitForPasswordField();
    }
  }
  if (!passSel) {
    throw new Error("PASSWORD_FIELD_NOT_FOUND");
  }

  await page.type(passSel, account.password, { delay: 20 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
    page.click('#passwordNext'),
  ]);

  // 2FA varsa
  const otpSelectorCandidates = [
    'input[type="tel"]',
    'input[name="totpPin"]',
    'input[autocomplete="one-time-code"]',
  ];
  const hasOtp = await (async () => {
    for (const s of otpSelectorCandidates) {
      if (await page.$(s)) return s;
    }
    return null;
  })();

  if (hasOtp) {
    if (account.totpSecret) {
      // otplib'i dışarıdan veriyoruz
      const { authenticator } = (await import("otplib")).default || await import("otplib");
      const code = authenticator.generate(account.totpSecret);
      await page.type(hasOtp, code);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
        page.keyboard.press("Enter"),
      ]);
    } else {
      browser.off("targetcreated", onTargetCreated);
      throw new Error("REQUIRES_2FA");
    }
  }

  // giriş tamam; event'i kaldır
  browser.off("targetcreated", onTargetCreated);
  return page;
}


// ---- Puppeteer oturumu ve yükleme ----
async function withBrowser(accountKey, fn) {
  const account = ACCOUNTS[accountKey];
  if (!account) throw new Error("Unknown accountKey");

  // Browserless'a bağlanırken defaultViewport'u kontrol etmek iyi olur
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.PUPPETEER_BROWSER_WSE,
    defaultViewport: null
  });

  const page = await robustLogin(browser, account);

  // Artık business paneline geçebiliriz:
  const result = await fn(page, browser);

  await browser.disconnect();
  return result;
}


async function uploadToGbp(page, { locationId, filePaths }) {
  // Doğrudan lokasyonun foto sayfasına
  await page.goto(`https://business.google.com/dashboard/l/${locationId}/photos`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // "Fotoğraf ekle" butonu için daha spesifik bir yaklaşım:
  // 1) Önce görünür bir upload tetikleyicisi ara
  const clickable = await page.$('div[role="button"], button');
  if (!clickable) throw new Error("UPLOAD_BUTTON_NOT_FOUND");

  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    clickable.click(),
  ]);

  await chooser.accept(filePaths);
  // Yükleme tamamlandı sinyali için kısa bir bekleme (gerekirse DOM kontrolü ile değiştir)
  await page.waitForTimeout(20000);
}


// ---- API: Drive ID'leri ile yükleme ----
app.post("/upload", async (req, res) => {
  const { accountKey, locationId, files } = req.body || {};
  if (!accountKey || !locationId || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: "accountKey, locationId, files gerekli" });
  }

  const q = getQueue(accountKey);
  try {
    const result = await q.add(async () => {
      const paths = [];
      for (const f of files) {
        const safe = (f.name || `${f.id}.bin`).replace(/[^\w.-]/g, "_");
        const dest = path.join(UPLOAD_DIR, safe);
        await downloadFromDrive(f.id, dest);
        paths.push(dest);
      }
      await withBrowser(accountKey, (page) => uploadToGbp(page, { locationId, filePaths: paths }));
      return { uploaded: paths.length };
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    const code = e.message === "REQUIRES_2FA" ? "REQUIRES_2FA" : "ERROR";
    return res.status(code === "REQUIRES_2FA" ? 428 : 500).json({ ok: false, code, error: e.message });
  }
});

// Sağlık kontrolü
app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Uploader API listening on " + port));
