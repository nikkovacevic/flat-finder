const https = require("https");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");

const LISTINGS_URL =
	"https://www.nepremicnine.net/oglasi-oddaja/podravska/maribor/kosaki,maribor,mb-center,koroska-vrata/stanovanje/velikost-od-50-do-100-m2/";
const SEEN_FILE = "seen_listings-nepremicnine.json";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "sl-SI,sl;q=0.9,en-US;q=0.8,en;q=0.7",
	"Accept-Encoding": "gzip, deflate, br",
	Connection: "keep-alive",
	"Upgrade-Insecure-Requests": "1",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Cache-Control": "max-age=0",
	"DNT": "1",
	"Referer": "https://www.google.com/",
	"Pragma": "no-cache",
};

function fetchUrl(url, redirectCount = 0) {
	return new Promise((resolve, reject) => {
		if (redirectCount > 5) return reject(new Error("Too many redirects"));
		const lib = url.startsWith("https") ? https : http;
		const req = lib.get(url, { headers: HEADERS }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				return resolve(fetchUrl(res.headers.location, redirectCount + 1));
			}
			if (res.statusCode !== 200) {
				return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
			}

			// Decompress if needed
			const encoding = res.headers["content-encoding"];
			let stream = res;
			if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
			else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
			else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());

			let data = "";
			stream.on("data", (chunk) => (data += chunk));
			stream.on("end", () => resolve(data));
			stream.on("error", reject);
		});
		req.on("error", reject);
	});
}

function loadSeen() {
	if (fs.existsSync(SEEN_FILE)) {
		return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
	}
	return new Set();
}

function saveSeen(seen) {
	fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]), "utf8");
}

function stripTags(html) {
	return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parseListings(html) {
	const listings = [];

	// Split on mainEntityOfPage — appears exactly once per listing
	const chunks = html.split('<meta itemprop="mainEntityOfPage"');

	// First chunk is the page header — skip it
	for (let i = 1; i < chunks.length; i++) {
		const block = chunks[i];
		try {
			// Canonical listing URL
			const canonicalMatch = block.match(/content="(https:\/\/www\.nepremicnine\.net\/oglasi-oddaja\/[^"]+)"/);
			if (!canonicalMatch) continue;
			const listingUrl = canonicalMatch[1];

			// Numeric listing ID from URL slug (e.g. _7273119)
			const idMatch = listingUrl.match(/_(\d+)\//);
			const id = idMatch ? idMatch[1] : crypto.createHash("md5").update(listingUrl).digest("hex");

			// Title from <h2> inside .url-title-d anchor
			const titleMatch = block.match(/class="url-title-d"[^>]*>\s*<h2>([\s\S]*?)<\/h2>/);
			const title = titleMatch ? stripTags(titleMatch[1]) : "N/A";

			// Room type e.g. "2-sobno"
			const tipiMatch = block.match(/<span class="tipi">([\s\S]*?)<\/span>/);
			const tipi = tipiMatch ? stripTags(tipiMatch[1]) : "";

			// "Novo" badge
			const isNew = /label-new/.test(block);

			// Short description
			const descMatch = block.match(/itemprop="description">([\s\S]*?)<\/p>/);
			const description = descMatch ? stripTags(descMatch[1]) : "";

			// Price from <h6>
			const priceMatch = block.match(/<h6[^>]*>([\s\S]*?)<\/h6>/);
			const price = priceMatch
				? stripTags(priceMatch[1]).replace(/&euro;/g, "€").split(/\s{2,}/)[0].trim()
				: "N/A";

			// Size (m²) — li containing velikost.svg
			const sizeMatch = block.match(/velikost\.svg[^>]*>([^<]+)/);
			const size = sizeMatch ? sizeMatch[1].trim() + "²" : "N/A";

			// Year built — li containing leto.svg
			const yearMatch = block.match(/leto\.svg[^>]*>([^<]+)/);
			const year = yearMatch ? yearMatch[1].trim() : "";

			// Floor — li containing nadstropje.svg
			const floorMatch = block.match(/nadstropje\.svg[^>]*>([^<]+)/);
			const floor = floorMatch ? floorMatch[1].trim() : "";

			// Image (lazy-loaded, stored in data-src)
			const imgMatch = block.match(/data-src="(https:\/\/img\.nepremicnine\.net[^"]+)"/);
			const image = imgMatch ? imgMatch[1] : null;

			// Seller name
			const sellerMatch = block.match(/itemprop="name" content="([^"]+)"/);
			const seller = sellerMatch ? sellerMatch[1] : "";

			listings.push({ id, title, tipi, isNew, description, price, size, year, floor, seller, url: listingUrl, image });
		} catch (e) {
			console.error("Error parsing listing block:", e.message);
		}
	}

	return listings;
}

function postToDiscord(listing) {
	return new Promise((resolve, reject) => {
		const now = new Date();

		const fields = [
			{ name: "💰 Cena", value: listing.price || "N/A", inline: true },
			{ name: "📐 Velikost", value: listing.size || "N/A", inline: true },
		];
		if (listing.tipi)   fields.push({ name: "🛏️ Tip",         value: listing.tipi,  inline: true });
		if (listing.year)   fields.push({ name: "🏗️ Leto",        value: listing.year,  inline: true });
		if (listing.floor)  fields.push({ name: "🏢 Nadstropje",  value: listing.floor, inline: true });
		if (listing.seller) fields.push({ name: "👤 Ponudnik",    value: listing.seller,inline: true });

		const embed = {
			title: `${listing.isNew ? "🆕 " : ""}${listing.title}`,
			url: listing.url,
			description: listing.description || undefined,
			color: listing.isNew ? 0xe74c3c : 0x2ecc71,
			fields,
			footer: {
				text: `Nepremicnine.net • ${now.toLocaleDateString("sl-SI")} ${now.toLocaleTimeString("sl-SI", { hour: "2-digit", minute: "2-digit" })}`,
			},
			timestamp: now.toISOString(),
		};

		if (listing.image) embed.thumbnail = { url: listing.image };

		const body = JSON.stringify({ username: "🏠 Nepremičnine Bot", embeds: [embed] });

		const webhookUrl = new URL(DISCORD_WEBHOOK_URL);
		const options = {
			hostname: webhookUrl.hostname,
			path: webhookUrl.pathname + webhookUrl.search,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
			},
		};

		const req = https.request(options, (res) => {
			if (res.statusCode >= 200 && res.statusCode < 300) {
				console.log(`✅ Posted: ${listing.title} — ${listing.price}`);
				resolve();
			} else {
				reject(new Error(`Discord webhook returned ${res.statusCode}`));
			}
			res.resume();
		});

		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

async function main() {
	if (!DISCORD_WEBHOOK_URL) {
		throw new Error("DISCORD_WEBHOOK_URL environment variable is not set");
	}

	console.log(`[${new Date().toISOString()}] Starting scrape...`);

	const seen = loadSeen();
	const html = await fetchUrl(LISTINGS_URL);
	const listings = parseListings(html);
	console.log(`Found ${listings.length} listings total.`);

	const newListings = listings.filter((l) => !seen.has(l.id));
	console.log(`New listings: ${newListings.length}`);

	for (const listing of newListings) {
		await postToDiscord(listing);
		seen.add(listing.id);
		await sleep(2000); // wait 2 seconds between each post
	}

	saveSeen(seen);
	console.log("Done.");
}

// Add this helper function:
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});