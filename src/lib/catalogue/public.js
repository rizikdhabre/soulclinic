import { cache } from "react";
import { ObjectId } from "mongodb";
import { getCollection } from "@/lib/db";
import { PUBLIC_FILTER, publicTreatment, validId } from "./model";
// React cache deduplicates only within one server render. No shared stale cache.
export const getPublicTreatments = cache(async () => {
  const collection = await getCollection("treatments");
  return (await collection.find(PUBLIC_FILTER).sort({ createdAt: 1, _id: 1 }).toArray()).map(publicTreatment);
});
export const getPublicTreatment = cache(async (key) => {
  if (!validId(key)) return null;
  const collection = await getCollection("treatments");
  return publicTreatment(await collection.findOne({ $and: [PUBLIC_FILTER, { _id: new ObjectId(key) }] }));
});
export async function getHeroImage() {
  const settings = await getCollection("settings");
  const record = await settings.findOne({ key: "homepage" }, { projection: { heroImageUrl: 1 } });
  return record?.heroImageUrl || null;
}
