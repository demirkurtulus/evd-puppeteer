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

// Hesap konfigleri (env: ACCOUNTS_JSON)
// Örnek: { "evd_main": { "email":"...", "password":"...", "totpSecret":"..." } }
const ACCOUNTS = JSON.parse(process.env.ACCOUNTS_JSON || "{}");

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

// ---- Puppeteer oturumu ve yükleme ----
async function withBrowser(accountKey, fn) {
  const account = ACCOUNTS[accountKey];
  if (!account) throw new Error("Unknown accountKey");

  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.PUPPETEER_BROWSER_WSE
  });
  const page = await browser.newPage();

  // Hızlı login akışı
  await page.goto("https://accounts.google.com/signin", { waitUntil: "networkidle0" });
  await page.type('input[type="email"]', account.email);
  await page.click("#identifierNext");

  await page.waitForSelector('input[type="password"]', { visible: true });
  await page.type('input[type="password"]', account.password);
  await page.click("#passwordNext");

  // 2FA ihtimali
  try {
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 8000 });
  } catch (_) {}
  const otpSelector = 'input[type="tel"], input[name="totpPin"]';
  const hasOtp = await page.$(otpSelector);
  if (hasOtp) {
    if (account.totpSecret) {
      const code = otplib.authenticator.generate(account.totpSecret);
      await page.type(otpSelector, code);
      await page.keyboard.press("Enter");
      await page.waitForNavigation({ waitUntil: "networkidle0" });
    } else {
      await browser.disconnect();
      throw new Error("REQUIRES_2FA");
    }
  }

  const result = await fn(page, browser);
  await browser.disconnect();
  return result;
}

async function uploadToGbp(page, { locationId, filePaths }) {
  // Lokasyonun foto sayfasına git
  await page.goto(`https://business.google.com/dashboard/l/${locationId}/photos`, { waitUntil: "networkidle0" });

  // Yükleme butonu (gerekirse selector özelleştir)
  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.waitForSelector('button,div[role="button"]', { visible: true })
      .then(() => page.click('button,div[role="button"]'))
  ]);

  await chooser.accept(filePaths);
  await page.waitForTimeout(15000); // yükleme süresi, istersen DOM kontrolü ekleyebilirsin
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
