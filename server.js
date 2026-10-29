import express from "express";
import { gotScraping } from "got-scraping";
import { CookieJar } from "tough-cookie";
import CryptoJS from "crypto-js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ================= HELPER FUNCTIONS ================= */
function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&#8217;|&#8216;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#038;|&amp;/g, "&")
    .replace(/<[^>]*>/g, "")
    .trim();
}

/* ================= 1. NATIVE SEARCH ================= */
async function nativeSearchCineSubz(query) {
  const formattedQuery = encodeURIComponent(query.trim()).replace(/%20/g, "+");
  const searchUrl = `https://cinesubz.co/?s=${formattedQuery}`;

  // Let gotScraping handle all headers, TLS, and HTTP/2 automatically
  const res = await gotScraping({
    url: searchUrl,
    headers: { Referer: "https://cinesubz.co/" },
    timeout: { request: 15000 }
  });

  const html = String(res.body || "");
  const results = [];
  const seenUrls = new Set();
  const parts = html.split(/<div id="item-\d+"\s+class="display-item">/i).slice(1);

  for (const block of parts) {
    const linkMatch = block.match(/<a\s+href="([^"]+)"[^>]*?(?:title="([^"]*)")?/i);
    const h3Match =
      block.match(/<div class="item-desc-title">\s*<h3>([\s\S]*?)<\/h3>/i) ||
      block.match(/<h3>([\s\S]*?)<\/h3>/i);
    const imgMatch = block.match(/<img[^>]+(?:data-original|src)="([^"]+)"/i);
    const imdbMatch = block.match(/<span class="imdb-score">([^<]+)<\/span>/i);
    const qualityMatch = block.match(/<span class="badge-(?:quality|season)-corner">([^<]+)<\/span>/i);

    const url = linkMatch ? linkMatch[1].trim() : null;
    const rawTitle = (h3Match && h3Match[1]) || (linkMatch && linkMatch[2]) || "";
    const title = decodeHtmlEntities(rawTitle);
    const image = imgMatch ? imgMatch[1].trim() : "";
    const imdb = imdbMatch ? imdbMatch[1].trim() : "N/A";
    const quality = qualityMatch ? qualityMatch[1].trim() : "N/A";

    if (url && title && !seenUrls.has(url)) {
      seenUrls.add(url);
      results.push({ title, url, image, imdb, quality });
    }
  }

  return results;
}

/* ================= 2. MOVIE PAGE SCRAPER ================= */
async function nativeScrapeMovie(movieUrl) {
  const parsed = new URL(movieUrl);
  const movieHost = parsed.origin;

  const res = await gotScraping({
    url: movieUrl,
    headers: { Referer: `${movieHost}/` },
    timeout: { request: 15000 }
  });

  const html = String(res.body || "");
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replace(/- CineSubz.*$/i, ""))
    : "Movie Details";

  const downloadLinks = [];
  const seenUrls = new Set();
  const btnRegex =
    /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"][^'"]*movie-download-button[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const buttonJobs = [];

  while ((match = btnRegex.exec(html)) !== null) {
    const rawLink = match[1].trim();
    const innerHtml = match[2];
    const metaMatch = innerHtml.match(/class=['"][^'"]*movie-download-meta[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i);
    const typeMatch = innerHtml.match(/class=['"][^'"]*movie-download-type[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i);

    const qualityLabel = metaMatch
      ? decodeHtmlEntities(metaMatch[1])
      : typeMatch
      ? decodeHtmlEntities(typeMatch[1])
      : "Quality";

    buttonJobs.push(
      (async () => {
        try {
          const pageRes = await gotScraping({
            url: rawLink,
            headers: { Referer: movieUrl },
            timeout: { request: 12000 }
          });
          const pData = String(pageRes.body || "");
          const pathMatch = pData.match(
            /(?:https?:\/\/(?:google\.com|sonic-cloud\.online|drive\.csplayer2\.space))?\/(server\d+\/[^\s'"<>]+\.mp4)/i
          );

          if (pathMatch) {
            let cleanPath = pathMatch[1].replace(/(server\d+\/)\d+:\//, "$1");
            return {
              quality: qualityLabel,
              directUrl: `https://drive.csplayer2.space/${cleanPath}`,
            };
          }
        } catch (_) {}
        return null;
      })()
    );
  }

  const resolved = await Promise.all(buttonJobs);
  for (const item of resolved) {
    if (item && !seenUrls.has(item.directUrl)) {
      seenUrls.add(item.directUrl);
      downloadLinks.push(item);
    }
  }

  return { title, downloadLinks };
}

/* ================= 3. DIRECT DOWNLOAD RESOLVER (WAF BYPASSED) ================= */
async function resolveDirectLinks(streamUrl) {
  let targetLink = streamUrl.replace(/^https:\/\/[^\/]+/, "https://drive.csplayer2.space");

  const serverMatch = targetLink.match(/\/server(\d+)\//) || targetLink.match(/server(\d+)/);
  const detectedServer = serverMatch ? serverMatch[1] : "7";

  const serversToTry = [detectedServer, "7", "2", "1", "3", "4", "5", "6", "8", "9", "11", "21"];
  const uniqueServers = [...new Set(serversToTry)];

  const debugLogs = [];

  for (const serverNum of uniqueServers) {
    let movieUrl = targetLink;
    if (serverMatch) {
      movieUrl = movieUrl.replace(/\/server\d+\//, `/server${serverNum}/`);
    }

    debugLogs.push(`Testing Server #${serverNum} (${movieUrl})`);
    
    // CookieJar is crucial for Cloudflare turnstile & session persistency
    const cookieJar = new CookieJar();

    try {
      const parsedUrl = new URL(movieUrl);
      const domain = parsedUrl.origin;
      const currentPath = parsedUrl.pathname + parsedUrl.search;

      // 1. Initial Access to generate Cloudflare Cookies
      const initialRes = await gotScraping({
        url: movieUrl,
        cookieJar,
        headers: { Referer: "https://cinesubz.co/" },
        timeout: { request: 12000 }
      });

      let html = String(initialRes.body || "");
      let realPageUrl = movieUrl;
      let payloads = html.match(/[0-9a-fA-F]{200,}/g) || [];

      // 2. Download-Data API Call
      if (payloads.length === 0) {
        const apiUrl = `${domain}/api/download-data${currentPath}`;
        try {
          const apiResponse = await gotScraping({
            url: apiUrl,
            cookieJar,
            headers: {
              Accept: "application/json, text/plain, */*",
              Referer: movieUrl
            },
            responseType: 'json',
            timeout: { request: 12000 }
          });

          if (apiResponse.body && apiResponse.body.redirect) {
            realPageUrl = apiResponse.body.redirect;
            if (!realPageUrl.startsWith("http")) realPageUrl = domain + realPageUrl;

            const pageResponse = await gotScraping({
              url: realPageUrl,
              cookieJar,
              headers: { Referer: movieUrl },
              timeout: { request: 12000 }
            });
            
            html = String(pageResponse.body || "");
            payloads = html.match(/[0-9a-fA-F]{200,}/g) || [];
          } else {
             debugLogs.push(`Server #${serverNum} API gave no redirect URL.`);
          }
        } catch (apiErr) {
          debugLogs.push(`Server #${serverNum} API error: ${apiErr.response?.statusCode || apiErr.message}`);
          continue;
        }
      }

      if (payloads.length === 0) {
        debugLogs.push(`Server #${serverNum}: No Hex Payloads extracted from HTML.`);
        continue;
      }

      // Collect Keys
      const allStrings = [...html.matchAll(/(["'])(.*?)\1/g)].map((m) => m[2]);
      const keysToTry = [...new Set(allStrings)].filter((k) => k && k.length >= 4 && k.length <= 40);
      keysToTry.push("kasun", "cinesubz.lk", "CSPlayer", "ravindu01manoj", "jhutmupd", "dgpjjitp");

      const resolved = [];

      // 3. Post Binary Payloads
      for (const hexPayload of payloads) {
        try {
          const payloadBytes = Buffer.from(hexPayload, "hex");
          
          const dlResponse = await gotScraping({
            url: realPageUrl,
            method: 'POST',
            body: payloadBytes,
            cookieJar,
            headers: {
              "Content-Type": "application/octet-stream",
              Referer: realPageUrl,
              Origin: domain
            },
            responseType: "buffer",
            timeout: { request: 12000 }
          });

          const responseText = dlResponse.body.toString("utf8");
          const encryptedUrlMatch = responseText.match(/U2FsdGVkX1[a-zA-Z0-9+/=]+/);

          if (encryptedUrlMatch) {
            const encryptedUrl = encryptedUrlMatch[0];
            for (const key of keysToTry) {
              if (!key || key.length < 3) continue;
              try {
                const decryptedBytes = CryptoJS.AES.decrypt(encryptedUrl, key);
                let decodedStr = decryptedBytes.toString(CryptoJS.enc.Utf8);

                if (decodedStr && !decodedStr.startsWith("http")) {
                  try {
                    decodedStr = Buffer.from(decodedStr, "base64").toString("utf8");
                  } catch (_) {}
                }

                if (decodedStr && decodedStr.startsWith("http")) {
                  resolved.push({ key, url: decodedStr });
                  break;
                }
              } catch (_) {}
            }
          }
        } catch (_) {} // Ignore payload specific errors
      }

      if (resolved.length > 0) {
        return {
          success: true,
          server: `server${serverNum}`,
          links: resolved,
          logs: debugLogs,
        };
      } else {
        debugLogs.push(`Server #${serverNum}: Decryption failed using all keys.`);
      }
    } catch (err) {
      debugLogs.push(`Server #${serverNum} failed: ${err.response?.statusCode || err.message}`);
    }
  }

  return {
    success: false,
    error: "Failed to decrypt from all servers.",
    logs: debugLogs,
  };
}

/* ================= EXPRESS ENDPOINTS ================= */
app.get("/api/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Query 'q' is required" });

  try {
    const data = await nativeSearchCineSubz(query);
    res.json({ success: true, count: data.length, data: data.slice(0, 15) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/movie", async (req, res) => {
  const { movieUrl } = req.body;
  if (!movieUrl) return res.status(400).json({ error: "movieUrl is required" });

  try {
    const data = await nativeScrapeMovie(movieUrl);
    if (!data.downloadLinks || data.downloadLinks.length === 0) {
      return res.status(404).json({ success: false, error: "No download links discovered" });
    }
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/resolve", async (req, res) => {
  const { directUrl } = req.body;
  if (!directUrl) return res.status(400).json({ error: "directUrl is required" });

  try {
    const result = await resolveDirectLinks(directUrl);
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 CineSubz Railway Web App active on port ${port}`);
});
