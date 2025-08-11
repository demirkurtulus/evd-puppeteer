import puppeteer from "puppeteer-core";

const ws = process.env.PUPPETEER_BROWSER_WSE;         // wss://...browserless?token=...
const email = process.env.GBIZ_EMAIL;
const pass = process.env.GBIZ_PASS;
const files = (process.env.UPLOAD_FILES || "").split(",").map(s => s.trim()); // /app/uploads/1.jpg,/app/uploads/2.jpg

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: ws });
  const page = await browser.newPage();

  // Google login
  await page.goto("https://accounts.google.com/signin", { waitUntil: "networkidle0" });
  await page.type('input[type="email"]', email);
  await page.click('#identifierNext');
  await page.waitForSelector('input[type="password"]', { visible: true });
  await page.type('input[type="password"]', pass);
  await page.click('#passwordNext');
  await page.waitForNavigation({ waitUntil: "networkidle0" });

  // GBP → Fotoğraflar
  await page.goto("https://business.google.com/", { waitUntil: "networkidle0" });
  // (Gerekirse işletme seçimi için selector ekle)
  await page.goto("https://business.google.com/photos", { waitUntil: "networkidle0" });

  // Yükleme tetikleme (buton selector’unu kendi arayüzüne göre güncelle)
  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.click('button,div[role="button"]')
  ]);

  await chooser.accept(files);
  await sleep(15000); // yüklemeyi bekle
  await browser.disconnect();
})();
