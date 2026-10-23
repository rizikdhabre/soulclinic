const origin = "https://soulclinc.net";
const paths = ["/", "/about", "/contact", "/dashboard", "/robots.txt", "/sitemap.xml", "/logo.PNG", "/logo.png", "/treatments/69dbaf697f07ea94b798a89f"];
const result = await Promise.all(paths.map(async (path) => {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(30000) });
  const html = await response.text();
  return {
    path, status: response.status, type: response.headers.get("content-type"),
    title: html.match(/<title>(.*?)<\/title>/)?.[1],
    canonical: html.match(/rel="canonical" href="([^"]+)"/)?.[1],
    h1: (html.match(/<h1[ >]/g) || []).length,
  };
}));
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), result }, null, 2));
