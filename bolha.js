const https = require("https");
const http = require("http");
const fs = require("fs");
const zlib = require("zlib");

const LISTINGS_URL =
	"https://www.bolha.com/oddaja-stanovanja?geo[locationIds]=27056,40950,27052";
const SEEN_FILE = "seen_listings-bolha.json";
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

	// Split on each regular listing item
	const chunks = html.split(/EntityList-item--Regular[^>]*data-href=/);

	// First chunk is page header — skip it
	for (let i = 1; i < chunks.length; i++) {
		const block = chunks[i];
		try {
			// Numeric ID
			const idMatch = block.match(/"id":(\d+)/);
			if (!idMatch) continue;
			const id = idMatch[1];

			// Listing URL
			const hrefMatch = block.match(/"(\/nepremicnine\/[^"]+)"/);
			const path = hrefMatch ? hrefMatch[1] : null;
			if (!path) continue;
			const listingUrl = `https://www.bolha.com${path}`;

			// Title
			const titleMatch = block.match(/class="link" href="[^"]+">([^<]+)<\/a><\/h3>/);
			const title = titleMatch ? titleMatch[1].trim() : "N/A";

			// Image (src starts with //)
			const imgMatch = block.match(/src="(\/\/www\.bolha\.com\/image[^"]+)"/);
			const image = imgMatch ? `https:${imgMatch[1]}` : null;

			// Description block
			const descMatch = block.match(/entity-description-main">([\s\S]*?)<\/div>/);
			const description = descMatch ? stripTags(descMatch[1]) : "";

			// Location — text after "Lokacija: " caption
			const locMatch = block.match(/entity-description-itemCaption">Lokacija: <\/span>([^<]+)/);
			const location = locMatch ? locMatch[1].trim() : "N/A";

			// Price — first price only (handles crossed-out old prices)
			const priceMatch = block.match(/class="price[^"]*">\s*([^<]+?)\s*<\/strong>/);
			const price = priceMatch ? priceMatch[1].trim() : "N/A";

			// Published date
			const dateMatch = block.match(/datetime="([^"]+)"/);
			const published = dateMatch
				? new Date(dateMatch[1]).toLocaleDateString("sl-SI")
				: "";

			listings.push({ id, title, description, location, price, published, url: listingUrl, image });
		} catch (e) {
			console.error("Error parsing listing block:", e.message);
		}
	}

	return listings;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function postToDiscord(listing) {
	return new Promise((resolve, reject) => {
		const now = new Date();

		const fields = [
			{ name: "💰 Cena", value: listing.price || "N/A", inline: true },
			{ name: "📍 Lokacija", value: listing.location || "N/A", inline: true },
		];
		if (listing.published) {
			fields.push({ name: "📅 Objavljeno", value: listing.published, inline: true });
		}

		const embed = {
			title: listing.title,
			url: listing.url,
			description: listing.description || undefined,
			color: 0x2ecc71,
			fields,
			footer: {
				text: `Bolha.com • ${now.toLocaleDateString("sl-SI")} ${now.toLocaleTimeString("sl-SI", { hour: "2-digit", minute: "2-digit" })}`,
			},
			timestamp: now.toISOString(),
		};

		if (listing.image) embed.thumbnail = { url: listing.image };

		const body = JSON.stringify({ username: "🏠 Bolha Bot", embeds: [embed] });

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
		await sleep(2000);
	}

	saveSeen(seen);
	console.log("Done.");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});