import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();
const url = process.env.MONGO_URI;
const dbName = "soul";
const client = new MongoClient(url);
let dbConnection = null;

async function connectDb() {
  if (dbConnection) return dbConnection;
  await client.connect();
  dbConnection = client.db(dbName);
  return dbConnection;
}

export async function getCollection(collectionName) {
  const db = await connectDb();
  return db.collection(collectionName);
}

export async function getMongoClient() {
  await connectDb();
  return client;
}
