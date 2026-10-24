// check-updater-feed.mjs — verify the published update feed is coherent.
//
// The in-app updater reads: releases/latest → latest.yml (+ latest-mac.yml /
// latest-linux.yml) → the installer asset named in that file. A release can
// publish fine and still leave the updater broken (wrong filename in the
// channel file, missing blockmap, version not bumped), so this check walks
// the exact same chain the app walks and fails loudly.
//
// Usage: node scripts/check-updater-feed.mjs [owner/repo]

const target = process.argv[2] || "Migratedboy/orplex-frountend";
const [owner, repo] = target.split("/");
const api = `https://api.github.com/repos/${owner}/${repo}`;
const headers = { "User-Agent": "orplex-updater-feed-check" };

async function head(url) {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  return { status: res.status, length: Number(res.headers.get("content-length") || 0) };
}

async function checkChannel(file) {
  const res = await fetch(`${api}/releases/latest`, { headers });
  if (!res.ok) throw new Error(`releases/latest → HTTP ${res.status}`);
  const release = await res.json();
  if (!release.tag_name) throw new Error("release has no tag");
  if (release.draft) throw new Error("latest release is a DRAFT — the updater cannot see it");
  if (release.prerelease) throw new Error("latest release is a prerelease");

  const ymlRes = await fetch(
    `https://github.com/${owner}/${repo}/releases/download/${release.tag_name}/${file}`,
    { redirect: "follow" },
  );
  if (!ymlRes.ok) throw new Error(`${file} → HTTP ${ymlRes.status}`);
  const yml = await ymlRes.text();

  const version = (yml.match(/^version:\s*(.+)$/m) || [])[1]?.trim();
  const asset = (yml.match(/^path:\s*(.+)$/m) || [])[1]?.trim();
  const declared = Number((yml.match(/^\s*size:\s*(\d+)/m) || [])[1]);
  if (!version || !asset) throw new Error(`${file} is missing version/path`);

  const assetUrl = `https://github.com/${owner}/${repo}/releases/download/${release.tag_name}/${encodeURIComponent(asset)}`;
  const assetHead = await head(assetUrl);
  if (assetHead.status !== 200) throw new Error(`installer ${asset} → HTTP ${assetHead.status}`);
  if (declared && assetHead.length && declared !== assetHead.length) {
    throw new Error(`size mismatch for ${asset}: channel says ${declared}, asset is ${assetHead.length}`);
  }
  const blockmap = await head(`${assetUrl}.blockmap`);
  return {
    file,
    tag: release.tag_name,
    version,
    asset,
    assetStatus: assetHead.status,
    assetBytes: assetHead.length,
    blockmapStatus: blockmap.status,
  };
}

(async () => {
  console.log(`feed check: ${target}`);
  for (const file of ["latest.yml", "latest-mac.yml", "latest-linux.yml"]) {
    try {
      const r = await checkChannel(file);
      console.log(
        `  OK ${file}: version=${r.version} asset=${r.asset} (${r.assetBytes} bytes, HTTP ${r.assetStatus}) blockmap=HTTP ${r.blockmapStatus}`,
      );
    } catch (err) {
      console.error(`  FAIL ${file}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log("feed OK");
})();
