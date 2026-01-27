"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import NeonLoader from "@/components/ui/loading";

const emptyService = {
  title: "",
  description: "",
  duration: "",
  price: "",
  currency: "ILS",
  imageUrl: "",
  imagePath: "",
  cupsCount: "",
};

export default function AdminTreatmentsPage() {
  const HUJAMA_ID = "6971f64c9b98d43b59cbb4a0";
  const isHujama = (treatment) => treatment._id === HUJAMA_ID;

  const [treatments, setTreatments] = useState([]);
  const [openIndex, setOpenIndex] = useState(null);
  const [menuIndex, setMenuIndex] = useState(null);
  const [serviceMenu, setServiceMenu] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [loading, setLoading] = useState(true);

  const [editedDescription, setEditedDescription] = useState("");
  const [editingIndex, setEditingIndex] = useState(null);
  const [editedTitle, setEditedTitle] = useState("");

  const [serviceEdit, setServiceEdit] = useState(null);
  const [serviceForm, setServiceForm] = useState(emptyService);
  const [selectedImage, setSelectedImage] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newTreatment, setNewTreatment] = useState({
    title: "",
    description: "",
    services: [],
  });

  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    fetchTreatments();
  }, []);

  const fetchTreatments = async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/admin/treatments");
      setTreatments(res.data);
    } finally {
      setLoading(false);
    }
  };

  const saveTitle = async (id) => {
    try {
      setIsSaving(true);
      await axios.put("/api/admin/treatments", {
        id,
        title: editedTitle,
        description: editedDescription,
      });
      setEditingIndex(null);
      fetchTreatments();
    } catch (error) {
      setIsSaving(false);
      console.error("Failed to save title/description:", error);
    }
  };

  const addTreatment = async () => {
    try {
      setIsAdding(true);

      if (!newTreatment.title.trim()) return;

      await axios.post("/api/admin/treatments", newTreatment);
      setShowAddModal(false);
      setNewTreatment({ title: "", description: "", services: [] });
      setIsAdding(false);
      fetchTreatments();
    } catch (error) {
      setIsAdding(false);
      console.error("Failed to add treatment:", error);
    }
  };

  const uploadServiceImage = async (treatmentId, serviceIndex) => {
    try {
      const formData = new FormData();
      formData.append("image", selectedImage);
      formData.append("treatmentId", treatmentId);
      formData.append("serviceIndex", serviceIndex);

      const res = await axios.post("/api/admin/upload-service-image", formData);
      return res.data;
    } catch (error) {
      console.error("Failed to upload image:", error);
    }
  };

  const saveService = async (treatmentId) => {
    if (isSaving) return;

    try {
      setIsSaving(true);

      let imageData = {
        url: serviceForm.imageUrl || "",
        path: serviceForm.imagePath || "",
      };

      if (selectedImage) {
        imageData = await uploadServiceImage(
          treatmentId,
          serviceEdit.index ?? Date.now(),
        );
      }

      const payload = {
        ...serviceForm,
        imageUrl: imageData.url,
        imagePath: imageData.path,
      };

      if (serviceEdit.index === null) {
        await axios.post("/api/admin/treatments/services", {
          treatmentId,
          service: payload,
        });
      } else {
        await axios.put("/api/admin/treatments/services", {
          treatmentId,
          serviceIndex: serviceEdit.index,
          service: payload,
        });
      }

      setServiceEdit(null);
      setServiceForm(emptyService);
      setSelectedImage(null);
      setServiceMenu(null);
      await fetchTreatments();
    } catch (error) {
      console.error("Failed to save service:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDeleteTreatment = async () => {
    if (isDeleting) return;
    if (!confirmDelete?.id) return;

    try {
      setIsDeleting(true);

      await axios.delete("/api/admin/treatments", {
        data: { id: confirmDelete.id },
      });

      setConfirmDelete(null);
      await fetchTreatments();
    } catch (error) {
      console.error("Failed to delete treatment:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const confirmDeleteService = async () => {
    try {
      setIsDeleting(true);
      await axios.delete("/api/admin/treatments/services", {
        data: {
          treatmentId: confirmDelete.treatmentId,
          serviceIndex: confirmDelete.serviceIndex,
        },
      });
      setConfirmDelete(null);
      setIsDeleting(false);
      fetchTreatments();
    } catch (error) {
      setIsDeleting(false);
      console.error("Failed to delete service:", error);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <NeonLoader width={500} height={200} />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto py-16 px-6 bg-background text-foreground">
      <div className="flex justify-between items-center mb-10">
        <h1 className="text-4xl font-bold">العلاجات</h1>
        <button
          onClick={() => setShowAddModal(true)}
          disabled={isAdding}
          className="px-5 py-2 rounded-xl bg-primary text-primary-foreground"
        >
          إضافة علاج+
        </button>
      </div>

      <div className="space-y-6">
        {treatments.map((treatment, index) => {
          const isOpen = openIndex === index;
          const hujama = isHujama(treatment);

          return (
            <div
              key={treatment._id}
              className="border border-border rounded-2xl bg-background"
            >
              <div className="flex justify-between items-start p-6">
                {editingIndex === index ? (
                  <div className="flex flex-col gap-3 w-full mr-4">
                    <div className="flex gap-2">
                      <input
                        value={editedTitle}
                        onChange={(e) => setEditedTitle(e.target.value)}
                        className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded-md w-full"
                        style={{ WebkitTextFillColor: "var(--foreground)" }}
                      />

                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => saveTitle(treatment._id)}
                        className="px-4 py-2 rounded-lg bg-green-600 text-white"
                      >
                        حفظ
                      </button>
                    </div>

                    <textarea
                      value={editedDescription}
                      onChange={(e) => setEditedDescription(e.target.value)}
                      className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded-md w-full min-h-[80px]"
                      style={{ WebkitTextFillColor: "var(--foreground)" }}
                    />
                  </div>
                ) : (
                  <div className="w-full">
                    <h2 className="text-2xl font-semibold">
                      {treatment.title}
                    </h2>
                    <p className="text-foreground/70 mt-1">
                      {treatment.description}
                    </p>
                  </div>
                )}

                <div className="relative z-50 ml-4">
                  <button
                    onClick={() =>
                      setMenuIndex(menuIndex === index ? null : index)
                    }
                    className="p-2 border border-border rounded-lg"
                  >
                    ⋮
                  </button>

                  <AnimatePresence>
                    {menuIndex === index && (
                      <motion.div
                        initial={{ opacity: 0, y: -5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -5 }}
                        className="absolute end-0 mt-2 w-36 bg-background border border-border rounded-xl shadow-lg z-[9999]"
                      >
                        <button
                          onClick={() => {
                            setEditingIndex(index);
                            setEditedTitle(treatment.title);
                            setEditedDescription(treatment.description);
                            setMenuIndex(null);
                          }}
                          className="w-full text-left px-4 py-2 hover:bg-muted"
                        >
                          تغيير
                        </button>

                        <button
                          onClick={() => {
                            setOpenIndex(isOpen ? null : index);
                            setMenuIndex(null);
                          }}
                          className="w-full text-left px-4 py-2 hover:bg-muted"
                        >
                          {isOpen ? "اخفاء" : "عرض"}
                        </button>

                        <button
                          disabled={isDeleting}
                          onClick={() => {
                            if (isDeleting) return;
                            setConfirmDelete({
                              type: "treatment",
                              id: treatment._id,
                            });
                            setMenuIndex(null);
                          }}
                          className="w-full text-left px-4 py-2 text-destructive hover:bg-destructive/10"
                        >
                          حذف
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="border-t px-6 py-6"
                  >
                    <div className="flex justify-end mb-4">
                      <button
                        disabled={isAdding}
                        onClick={() => {
                          setServiceEdit({
                            treatmentId: treatment._id,
                            index: null,
                            isHujama: hujama,
                          });
                          setServiceForm(emptyService);
                          setSelectedImage(null);
                        }}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg"
                      >
                        إضافة خدمة +
                      </button>
                    </div>

                    <div className="relative w-full overflow-x-auto">
                      <table className="w-full min-w-[900px] relative order border-border border-collapse">
                        <thead className="border border-border">
                          <tr className="border-b border border-border">
                            <th className="text-left py-2 border border-border">
                              اسم الخدمة
                            </th>
                            <th className="text-start py-2 border border-border">
                              المدة
                            </th>
                            <th className="text-start py-2 border border-border">
                              السعر
                            </th>
                            <th className="text-start py-2 border border-border">
                              الوصف
                            </th>
                            {hujama && (
                              <th className="border p-2">عدد الكووس</th>
                            )}
                            <th className="text-start py-2 border border-border">
                              الصورة
                            </th>
                            <th className="text-right py-2 border border-border">
                              الإجراءات
                            </th>
                          </tr>
                        </thead>

                        <tbody>
                          {(treatment.services || []).map((s, i) => (
                            <tr
                              key={i}
                              className="border border-border align-top"
                            >
                              <td className="py-3 px-2 border border-border whitespace-nowrap">
                                {s.title}
                              </td>

                              <td className="py-3 px-2 border border-border whitespace-nowrap">
                                {s.duration}
                              </td>

                              <td className="py-3 px-2 border border-border whitespace-nowrap">
                                {s.price} {s.currency}
                              </td>

                              <td className="py-3 px-2 border border-border">
                                <div
                                  className="
                                    max-w-[240px] md:max-w-[320px]
                                    break-words whitespace-normal
                                    line-clamp-3 md:line-clamp-none
                                    text-sm
                                  "
                                >
                                  {s.description}
                                </div>
                              </td>

                              {hujama && (
                                <td className="border p-2 text-center">
                                  {s.cupsCount || "—"}
                                </td>
                              )}

                              <td className="py-3 px-2 border border-border">
                                {s.imageUrl ? (
                                  <button
                                    type="button"
                                    onClick={() => setPreviewImage(s.imageUrl)}
                                    className="block"
                                  >
                                    <img
                                      src={s.imageUrl}
                                      alt={s.title}
                                      className="
                                        object-cover rounded-lg border border-border
                                        w-12 h-12
                                        md:w-16 md:h-16
                                      "
                                    />
                                  </button>
                                ) : (
                                  <span className="text-foreground/50">—</span>
                                )}
                              </td>

                              <td className="relative z-50 text-right py-3 px-2 border border-border">
                                <div className="relative inline-block">
                                  <button
                                    onClick={() =>
                                      setServiceMenu(
                                        serviceMenu === `${index}-${i}`
                                          ? null
                                          : `${index}-${i}`,
                                      )
                                    }
                                    className="p-2 border border-border rounded-lg"
                                  >
                                    ⋮
                                  </button>

                                  <AnimatePresence>
                                    {serviceMenu === `${index}-${i}` && (
                                      <motion.div
                                        initial={{ opacity: 0, y: -5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -5 }}
                                        className="absolute end-0 mt-2 w-32 bg-background border border-border rounded-xl shadow-lg z-[9999]"
                                      >
                                        <button
                                          onClick={() => {
                                            setServiceEdit({
                                              treatmentId: treatment._id,
                                              index: i,
                                              isHujama: hujama,
                                            });
                                            setServiceForm({
                                              title: s.title ?? "",
                                              description: s.description ?? "",
                                              duration: s.duration ?? "",
                                              price: s.price ?? "",
                                              currency: s.currency ?? "ILS",
                                              ...(hujama
                                                ? {
                                                    cupsCount:
                                                      s.cupsCount ?? "",
                                                  }
                                                : {}),
                                              imageUrl: s.imageUrl ?? "",
                                              imagePath: s.imagePath ?? "",
                                            });
                                            setSelectedImage(null);
                                            setServiceMenu(null);
                                          }}
                                          className="w-full text-left px-4 py-2 hover:bg-muted"
                                        >
                                          تعديل
                                        </button>

                                        <button
                                          onClick={() => {
                                            setConfirmDelete({
                                              type: "service",
                                              treatmentId: treatment._id,
                                              serviceIndex: i,
                                            });
                                            setServiceMenu(null);
                                          }}
                                          className="w-full text-left px-4 py-2 text-destructive hover:bg-destructive/10"
                                        >
                                          حذف
                                        </button>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {previewImage && (
        <div
          className="fixed inset-0 z-[99999] bg-black/80 flex items-center justify-center"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] rounded-xl border border-border bg-background"
          />
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-background p-6 rounded-2xl w-full max-w-lg">
            <input
              placeholder="العنوان"
              value={newTreatment.title}
              onChange={(e) =>
                setNewTreatment((p) => ({ ...p, title: e.target.value }))
              }
              className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded w-full mb-3"
              style={{ WebkitTextFillColor: "var(--foreground)" }}
            />
            <textarea
              placeholder="الوصف"
              value={newTreatment.description}
              onChange={(e) =>
                setNewTreatment((p) => ({
                  ...p,
                  description: e.target.value,
                }))
              }
              className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded w-full mb-4 min-h-[110px]"
              style={{ WebkitTextFillColor: "var(--foreground)" }}
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowAddModal(false)}>Cancel</button>
              <button
               disabled={isSaving}
                onClick={addTreatment}
                className="bg-primary px-4 py-2 rounded text-white"
              >
                حفظ
              </button>
            </div>
          </div>
        </div>
      )}

      {serviceEdit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-background p-6 rounded-2xl w-full max-w-lg space-y-3">
            <input
              placeholder="العنوان"
              className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded-md w-full"
              style={{ WebkitTextFillColor: "var(--foreground)" }}
              value={serviceForm.title}
              onChange={(e) =>
                setServiceForm((p) => ({ ...p, title: e.target.value }))
              }
            />
            <input
              placeholder="المدة (بالدقائق)"
              type="number"
              className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded-md w-full"
              style={{ WebkitTextFillColor: "var(--foreground)" }}
              value={serviceForm.duration}
              onChange={(e) =>
                setServiceForm((p) => ({ ...p, duration: e.target.value }))
              }
            />
            <input
              placeholder="السعر"
              type="number"
              className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded-md w-full"
              style={{ WebkitTextFillColor: "var(--foreground)" }}
              value={serviceForm.price}
              onChange={(e) =>
                setServiceForm((p) => ({ ...p, price: e.target.value }))
              }
            />
            {serviceEdit.isHujama && (
              <input
                type="number"
                min={1}
                placeholder="عدد الزجاجات"
                className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded-md w-full"
                style={{ WebkitTextFillColor: "var(--foreground)" }}
                value={serviceForm.cupsCount}
                onChange={(e) =>
                  setServiceForm((p) => ({
                    ...p,
                    cupsCount: e.target.value,
                  }))
                }
              />
            )}
            <textarea
              placeholder="الوصف"
              className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded-md w-full min-h-[110px]"
              style={{ WebkitTextFillColor: "var(--foreground)" }}
              value={serviceForm.description}
              onChange={(e) =>
                setServiceForm((p) => ({ ...p, description: e.target.value }))
              }
            />
            <div className="space-y-2">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setSelectedImage(e.target.files?.[0] || null)}
                className="block w-full text-sm text-foreground file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-muted file:text-foreground hover:file:bg-muted/80"
              />

              {(selectedImage || serviceForm.imageUrl) && (
                <img
                  src={
                    selectedImage
                      ? URL.createObjectURL(selectedImage)
                      : serviceForm.imageUrl
                  }
                  alt="preview"
                  className="w-32 h-32 object-cover rounded-xl border border-border"
                />
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => {
                  setServiceEdit(null);
                  setServiceForm(emptyService);
                  setSelectedImage(null);
                }}
              >
                إلغاء
              </button>
              <button
                onClick={() => saveService(serviceEdit.treatmentId)}
                disabled={isSaving}
                className="bg-primary px-4 py-2 rounded text-white"
              >
                حفظ
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-background p-6 rounded-xl">
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)}>إلغاء</button>
              <button
                onClick={
                  confirmDelete.type === "treatment"
                    ? confirmDeleteTreatment
                    : confirmDeleteService
                }
                className="bg-destructive px-4 py-2 rounded text-white"
              >
                حذف
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
