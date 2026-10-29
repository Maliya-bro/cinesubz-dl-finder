import express from "express";
import axios from "axios";
import { connect } from "puppeteer-real-browser";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const defaultHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&#8217;|&#8216;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#038;|&amp;/g, "&")
    .replace(/<[^>]*>/g, "")
    .trim();
}

/* ================= 1. SEARCH ================= */
async function searchMovie(query) {
  const formattedQuery = encodeURIComponent(query.trim()).replace(/%20/g, "+");
  const searchUrl = `https://cinesubz.co/?s=${formattedQuery}`;

  const res = await axios.get(searchUrl, {
    timeout: 15000,
    headers: { ...defaultHeaders, Referer: "https://cinesubz.co/" },
  });

  const html = String(res.data || "");
  const results = [];
  const seenUrls = new Set();
  const parts = html.split(/<div id="item-\d+"\s+class="display-item">/i).slice(1);

  for (const block of parts) {
    const linkMatch = block.match(/<a\s+href="([^"]+)"[^>]*?(?:title="([^"]*)")?/i);
    const h3Match = block.match(/<div class="item-desc-title">\s*<h3>([\s\S]*?)<\/h3>/i) || block.match(/<h3>([\s\S]*?)<\/h3>/i);
    const imdbMatch = block.match(/<span class="imdb-score">([^<]+)<\/span>/i);
    const qualityMatch = block.match(/<span class="badge-(?:quality|season)-corner">([^<]+)<\/span>/i);

    const url = linkMatch ? linkMatch[1].trim() : null;
    const title = decodeHtmlEntities((h3Match && h3Match[1]) || (linkMatch && linkMatch[2]) || "");
    const imdb = imdbMatch ? imdbMatch[1].trim() : "N/A";
    const quality = qualityMatch ? qualityMatch[1].trim() : "N/A";

    if (url && title && !seenUrls.has(url)) {
      seenUrls.add(url);
      results.push({ title, url, imdb, quality });
    }
  }
  return results;
}

/* ================= 2. GET QUALITIES ================= */
async function scrapeQualities(movieUrl) {
  const res = await axios.get(movieUrl, {
    timeout: 15000,
    headers: defaultHeaders,
  });

  const html = String(res.data || "");
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/- CineSubz.*$/i, "")) : "Movie Details";

  const downloadLinks = [];
  const seenUrls = new Set();
  const btnRegex = /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"][^'"]*movie-download-button[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = btnRegex.exec(html)) !== null) {
    const rawLink = match[1].trim();
    const metaMatch = match[2].match(/class=['"][^'"]*movie-download-meta[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i);
    const qualityLabel = metaMatch ? decodeHtmlEntities(metaMatch[1]) : "Quality";

    try {
      const pageRes = await axios.get(rawLink, { headers: defaultHeaders, timeout: 10000 });
      const pData = String(pageRes.data || "");
      const pathMatch = pData.match(/(?:https?:\/\/(?:google\.com|sonic-cloud\.online|drive\.csplayer2\.space))?\/(server\d+\/[^\s'"<>]+\.mp4)/i);

      if (pathMatch) {
        let cleanPath = pathMatch[1].replace(/(server\d+\/)\d+:\//, "$1");
        const directUrl = `https://drive.csplayer2.space/${cleanPath}`;
        if (!seenUrls.has(directUrl)) {
          seenUrls.add(directUrl);
          downloadLinks.push({ quality: qualityLabel, directUrl });
        }
      }
    } catch (_) {}
  }
  return { title, downloadLinks };
}

/* ================= 3. RESOLVE USING PUPPETEER-REAL-BROWSER (DEEP LOGGING) ================= */
async function resolveViaRealBrowser(streamUrl) {
  let targetLink = streamUrl.replace(/^https:\/\/[^\/]+/, "https://drive.csplayer2.space");
  
  const logs = [`[PRB] Starting Browser Engine for: ${targetLink}`];
  let browserInstance = null;
  const discoveredLinks = [];

  try {
    logs.push("[PRB] Initializing Real Browser & Xvfb Display...");
    
    const { browser, page } = await connect({
      headless: false, // Essential for WAF Bypass
      turnstile: true, // Auto bypass Turnstile
      disableXvfb: false, // Virtual display on Linux
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--mute-audio',
        '--window-size=1280,720'
      ]
    });
    
    browserInstance = browser;
    logs.push("✅ Browser launched successfully!");

    // Catch Browser Console Logs
    page.on('console', msg => {
      const text = msg.text();
      if (!text.includes('ERR_BLOCKED_BY_CLIENT') && !text.includes('favicon')) {
        logs.push(`[BROWSER CONSOLE] ${msg.type().toUpperCase()}: ${text}`);
      }
    });

    // Catch Page Errors
    page.on('pageerror', err => {
      logs.push(`[BROWSER JS ERROR] ${err.toString()}`);
    });

    // Block DisableDevtool JS from kicking out the scraper
    await page.evaluateOnNewDocument(() => {
      window.DisableDevtool = function() {};
    });

    // Intercept Network Requests to catch the Decrypted Stream Link
    await page.setRequestInterception(true);
    
    page.on('request', request => {
      const url = request.url();
      if (
        (url.includes("cloudflarestorage.com") && url.includes(".mp4")) ||
        url.includes("terracloud") ||
        url.includes("pixeldrain") ||
        url.includes("telegram.me") || 
        url.includes("t.me")
      ) {
        logs.push(`✅ [INTERCEPTED] Final Direct Link: ${url}`);
        discoveredLinks.push({ url });
      }
      request.continue();
    });

    page.on('requestfailed', request => {
      const url = request.url();
      const error = request.failure()?.errorText;
      if (url.includes('drive.csplayer') || url.includes('cinesubz')) {
        logs.push(`⚠️ [NET_FAIL] ${url} - ${error}`);
      }
    });

    logs.push("🌐 Navigating to Target URL...");
    await page.goto(targetLink, { waitUntil: 'domcontentloaded', timeout: 60000 });
    logs.push("🌐 Page Loaded. Waiting for Cloudflare Validation...");

    // Wait for JS execution and Turnstile validation
    await new Promise(resolve => setTimeout(resolve, 8000));

    logs.push("🔍 Searching for Direct Download Buttons...");

    // Find all direct download buttons
    const buttons = await page.$$('.direct-download, .telegram-download');
    
    if (buttons.length === 0) {
       logs.push("❌ No download buttons found! Possible Cloudflare block or Dead Link.");
       const pageHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 300));
       logs.push(`[PAGE PREVIEW]: ${pageHTML}...`);
    } else {
       logs.push(`✅ Found ${buttons.length} Download Buttons. Attempting Click...`);
       for (let i = 0; i < buttons.length; i++) {
         try {
           logs.push(`🖱️ Clicking Button #${i + 1}...`);
           await buttons[i].click();
           await new Promise(r => setTimeout(r, 2000)); 
         } catch (e) {
           logs.push(`⚠️ Click failed on Button #${i + 1}: ${e.message}`);
         }
       }
    }

    await browserInstance.close();
    logs.push("🚪 Browser closed.");

    const uniqueLinks = Array.from(new Set(discoveredLinks.map(l => l.url))).map(url => ({ url }));

    if (uniqueLinks.length > 0) {
      return { success: true, server: "Puppeteer-Real-Browser", links: uniqueLinks, logs };
    } else {
      return { success: false, error: "Cloudflare bypassed, but no stream URL was generated.", logs };
    }

  } catch (error) {
    if (browserInstance) {
        try { await browserInstance.close(); } catch(e){}
    }
    logs.push(`❌ [FATAL PRB ERROR]: ${error.message}`);
    return { success: false, error: error.message, logs };
  }
}

/* ================= API ENDPOINTS ================= */
app.get("/api/search", async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: "Query required" });
  try {
    const data = await searchMovie(req.query.q);
    res.json({ success: true, count: data.length, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/movie", async (req, res) => {
  if (!req.body.movieUrl) return res.status(400).json({ error: "movieUrl required" });
  try {
    const data = await scrapeQualities(req.body.movieUrl);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/resolve", async (req, res) => {
  if (!req.body.directUrl) return res.status(400).json({ error: "directUrl required" });
  try {
    const result = await resolveViaRealBrowser(req.body.directUrl);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 CineSubz Real-Browser Engine running on port ${port}`);
});
