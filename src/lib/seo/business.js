export const business = Object.freeze({
  name: "SOUL", arabicName: "عيادة SOUL",
  alternateNames: ["SOUL Clinic", "عيادة سول", "عيادة SOUL"],
  origin: "https://soulclinc.net",
  phone: "+972532286019", displayPhone: "053-2286019",
  whatsapp: "https://wa.me/972532286019",
  locality: "دير حنا",
  instagram: "https://www.instagram.com/soul_clinica/",
  logo: "/logo.PNG", bookingPath: "/appointments",
  // Exact address, map pin, hours, qualifications and home-visit coverage await confirmation.
  openingHours: [], practitioners: [], homeVisitAreas: [],
});
export const absoluteUrl = (path = "/") => new URL(path, business.origin).href;
