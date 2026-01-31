"use client";

import { useState } from "react";
import axios from "axios";
import NeonLoader from "../ui/loading";

export default function HeroImageUploader() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  const upload = async () => {
    if (!file || loading) return;

    try {
      setLoading(true);

      const formData = new FormData();
      formData.append("image", file);

      await axios.post("/api/admin/upload-hero-image", formData);

      setFile(null);
      setPreview(null);
    } catch (e) {
      console.error("Hero upload failed:", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-border rounded-2xl p-6 bg-background relative">
      <h3 className="text-xl font-semibold mb-4">صورة الصفحة الرئيسية</h3>

      <input
        type="file"
        accept="image/*"
        disabled={loading}
        onChange={(e) => {
          const f = e.target.files?.[0];
          setFile(f || null);
          setPreview(f ? URL.createObjectURL(f) : null);
        }}
        className="block w-full text-sm text-foreground
          file:mr-4 file:py-2 file:px-4
          file:rounded-lg file:border-0
          file:bg-muted file:text-foreground"
      />

      {preview && (
        <img
          src={preview}
          alt="preview"
          className="mt-4 w-full max-w-xl h-64 object-cover rounded-xl border"
        />
      )}

      <button
        onClick={upload}
        disabled={!file || loading}
        className="mt-4 bg-primary px-6 py-2 rounded-lg text-primary-foreground disabled:opacity-50"
      >
        حفظ الصورة
      </button>
      {loading && (
        <div className="absolute inset-0 z-50 bg-background/80 flex items-center justify-center rounded-2xl">
          <NeonLoader width={320} height={120} />
        </div>
      )}
    </div>
  );
}
