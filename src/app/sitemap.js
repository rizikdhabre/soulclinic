export default function sitemap() {
  const baseUrl = "https://soulclinc.net";
  const now = new Date();

  return [
    {
      url: `${baseUrl}/`,
      lastModified: now,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: now,
    },
    {
      url: `${baseUrl}/contact`,
      lastModified: now,
    },
    {
      url: `${baseUrl}/dashboard`,
      lastModified: now,
    },
  ];
}
