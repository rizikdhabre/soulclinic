import "server-only";

let bucketPromise;

async function createStorageBucket() {
  // Retain deployed variable names while using the native Cloud Storage client.
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (!bucketName) {
    throw new Error("FIREBASE_STORAGE_BUCKET is required for image storage.");
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  const options = projectId ? { projectId } : {};

  if (clientEmail || privateKey) {
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY together, or omit credentials to use ADC.",
      );
    }
    options.credentials = {
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, "\n"),
    };
  }

  const { Storage } = await import("@google-cloud/storage");
  return new Storage(options).bucket(bucketName);
}

export function getStorageBucket() {
  if (!bucketPromise) {
    // Share initialization across requests without caching a failed attempt.
    bucketPromise = createStorageBucket().catch((error) => {
      bucketPromise = undefined;
      throw error;
    });
  }
  return bucketPromise;
}
