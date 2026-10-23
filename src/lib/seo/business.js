export const business = Object.freeze({
  name: "SOUL Clinic", arabicName: "عيادة SOUL",
  alternateNames: ["SOUL", "عيادة سول", "عيادة SOUL"],
  origin: "https://soulclinc.net",
  phone: "+972532286019", displayPhone: "053-2286019",
  whatsapp: "https://wa.me/972532286019",
  locality: "دير حنا", streetAddress: "شارع القدس",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=32.8612376,35.36135",
  latitude: 32.8612376, longitude: 35.36135,
  instagram: "https://www.instagram.com/soul_clinica/",
  logo: "/logo.PNG", bookingPath: "/appointments",
  // Hours, qualifications and home-visit coverage await owner confirmation.
  openingHours: [], practitioners: [], homeVisitAreas: [],
});
export const absoluteUrl = (path = "/") => new URL(path, business.origin).href;
