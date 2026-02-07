"use client";

import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import NeonLoader from "@/components/ui/loading";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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

const makeKey = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const ensureServiceKeys = (treatments) =>
  (treatments || []).map((t) => ({
    ...t,
    services: (t.services || []).map((s) => ({
      ...s,
      __key: s.__key || s._id || s.imagePath || makeKey(),
    })),
  }));

const stripClientKeys = (services) =>
  (services || []).map(({ __key, ...rest }) => rest);

function SortableHandleCell({ listeners, attributes }) {
  return (
    <td
      className="border px-2 cursor-grab active:cursor-grabbing select-none touch-none"
      {...attributes}
      {...listeners}
    >
      <span className="text-xl">⋮⋮</span>
    </td>
  );
}

function SortableRow({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <tr ref={setNodeRef} style={style}>
      <SortableHandleCell attributes={attributes} listeners={listeners} />
      {children}
    </tr>
  );
}

function SortableCard({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border border-border rounded-xl p-3 bg-background"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="shrink-0 cursor-grab active:cursor-grabbing select-none touch-none border border-border rounded-lg px-2 py-1"
          {...attributes}
          {...listeners}
          aria-label="Drag"
        >
          ⋮⋮
        </button>
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

export default function AdminTreatmentsPage() {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );

  const HUJAMA_ID = "6971f64c9b98d43b59cbb4a0";
  const isHujama = useCallback((treatment) => treatment?._id === HUJAMA_ID, []);

  /* ===================== STATE ===================== */

  const [treatments, setTreatments] = useState([]);
  const [openIndex, setOpenIndex] = useState(null);
  const [menuIndex, setMenuIndex] = useState(null);
  const [serviceMenu, setServiceMenu] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [loading, setLoading] = useState(true);

  const [editedTitle, setEditedTitle] = useState("");
  const [editedDescription, setEditedDescription] = useState("");
  const [editingIndex, setEditingIndex] = useState(null);

  const [serviceEdit, setServiceEdit] = useState(null);
  const [serviceForm, setServiceForm] = useState(emptyService);
  const [selectedImage, setSelectedImage] = useState(null);

  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [expandedDesc, setExpandedDesc] = useState(null);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newTreatment, setNewTreatment] = useState({
    title: "",
    description: "",
    services: [],
  });

  const [confirmDelete, setConfirmDelete] = useState(null);

  /* ===================== FETCH ===================== */

  const fetchTreatments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/admin/treatments");
      setTreatments(ensureServiceKeys(res.data));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTreatments();
  }, [fetchTreatments]);

  /* ===================== ADD TREATMENT ===================== */

  const addTreatment = useCallback(async () => {
    if (isAdding) return;
    if (!newTreatment.title.trim() || !newTreatment.description.trim()) return;

    setIsAdding(true);

    try {
      const res = await axios.post("/api/admin/treatments", {
        title: newTreatment.title,
        description: newTreatment.description,
        services: [],
      });

      const createdTreatment = {
        _id: res.data.id,
        title: newTreatment.title,
        description: newTreatment.description,
        services: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      setTreatments((prev) => [...prev, createdTreatment]);
      setShowAddModal(false);
      setNewTreatment({ title: "", description: "", services: [] });
    } catch (err) {
      console.error("Failed to add treatment:", err);
    } finally {
      setIsAdding(false);
    }
  }, [isAdding, newTreatment]);

  /* ===================== UPDATE TITLE / DESCRIPTION ===================== */

  const saveTitle = useCallback(
    async (id) => {
      if (isSaving) return;

      const backup = treatments.find((t) => t._id === id);

      // optimistic
      setTreatments((prev) =>
        prev.map((t) =>
          t._id === id
            ? { ...t, title: editedTitle, description: editedDescription }
            : t,
        ),
      );

      setEditingIndex(null);
      setIsSaving(true);

      try {
        await axios.put("/api/admin/treatments", {
          id,
          title: editedTitle,
          description: editedDescription,
        });
      } catch (err) {
        console.error("Failed to update treatment:", err);
        setTreatments((prev) => prev.map((t) => (t._id === id ? backup : t)));
      } finally {
        setIsSaving(false);
      }
    },
    [isSaving, treatments, editedTitle, editedDescription],
  );

  /* ===================== DELETE TREATMENT ===================== */

  const confirmDeleteTreatment = useCallback(async () => {
    if (isDeleting || !confirmDelete?.id) return;

    const backup = treatments.find((t) => t._id === confirmDelete.id);

    // optimistic
    setTreatments((prev) => prev.filter((t) => t._id !== confirmDelete.id));
    setConfirmDelete(null);
    setIsDeleting(true);

    try {
      await axios.delete("/api/admin/treatments", {
        data: { id: backup._id },
      });
    } catch (err) {
      console.error("Failed to delete treatment:", err);
      setTreatments((prev) => [...prev, backup]);
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, confirmDelete, treatments]);

  /* ===================== SERVICE IMAGE UPLOAD ===================== */

  const uploadServiceImage = useCallback(
    async (treatmentId, serviceIndex) => {
      const formData = new FormData();
      formData.append("image", selectedImage);
      formData.append("treatmentId", treatmentId);
      formData.append("serviceIndex", serviceIndex);

      const res = await axios.post("/api/admin/upload-service-image", formData);
      return res.data;
    },
    [selectedImage],
  );

  /* ===================== ADD / UPDATE SERVICE ===================== */

  const saveService = useCallback(
    async (treatmentId) => {
      if (isSaving) return;

      setIsSaving(true);

      let imageData = {
        url: serviceForm.imageUrl || "",
        path: serviceForm.imagePath || "",
      };

      try {
        if (selectedImage) {
          imageData = await uploadServiceImage(
            treatmentId,
            serviceEdit.index ?? Date.now(),
          );
        }

        const payload = {
          ...serviceForm,
          __key: serviceForm.__key || makeKey(),
          imageUrl: imageData.url,
          imagePath: imageData.path,
        };

        if (serviceEdit.index === null) {
          // server
          await axios.post("/api/admin/treatments/services", {
            treatmentId,
            service: stripClientKeys([payload])[0],
          });

          // optimistic
          setTreatments((prev) =>
            prev.map((t) =>
              t._id === treatmentId
                ? { ...t, services: [...(t.services || []), payload] }
                : t,
            ),
          );
        } else {
          await axios.put("/api/admin/treatments/services", {
            treatmentId,
            serviceIndex: serviceEdit.index,
            service: stripClientKeys([payload])[0],
          });

          setTreatments((prev) =>
            prev.map((t) =>
              t._id === treatmentId
                ? {
                    ...t,
                    services: (t.services || []).map((s, i) =>
                      i === serviceEdit.index ? payload : s,
                    ),
                  }
                : t,
            ),
          );
        }

        setServiceEdit(null);
        setServiceForm(emptyService);
        setSelectedImage(null);
        setServiceMenu(null);
      } catch (err) {
        console.error("Failed to save service:", err);
      } finally {
        setIsSaving(false);
      }
    },
    [isSaving, serviceForm, selectedImage, uploadServiceImage, serviceEdit],
  );

  /* ===================== DELETE SERVICE ===================== */

  const confirmDeleteService = useCallback(async () => {
    if (isDeleting) return;
    const { treatmentId, serviceIndex } = confirmDelete || {};
    if (!treatmentId && treatmentId !== "") return;
    if (serviceIndex === null || serviceIndex === undefined) return;

    const treatment = treatments.find((t) => t._id === treatmentId);
    const backup = treatment?.services?.[serviceIndex];

    // optimistic
    setTreatments((prev) =>
      prev.map((t) =>
        t._id === treatmentId
          ? {
              ...t,
              services: (t.services || []).filter((_, i) => i !== serviceIndex),
            }
          : t,
      ),
    );

    setConfirmDelete(null);
    setIsDeleting(true);

    try {
      await axios.delete("/api/admin/treatments/services", {
        data: { treatmentId, serviceIndex },
      });
    } catch (err) {
      console.error("Failed to delete service:", err);
      // rollback (best-effort insert back)
      setTreatments((prev) =>
        prev.map((t) =>
          t._id === treatmentId
            ? { ...t, services: [...(t.services || []), backup] }
            : t,
        ),
      );
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, confirmDelete, treatments]);

  /* ===================== SERVICE REORDER (DRAG) ===================== */

  const handleServiceDragEnd = useCallback(
    async (event, treatment) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const services = treatment.services || [];
      const oldIndex = services.findIndex((s) => s.__key === active.id);
      const newIndex = services.findIndex((s) => s.__key === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reorderedServices = arrayMove(services, oldIndex, newIndex);

      // optimistic
      setTreatments((prev) =>
        prev.map((t) =>
          t._id === treatment._id ? { ...t, services: reorderedServices } : t,
        ),
      );

      try {
        await axios.put("/api/admin/treatments/services/reorder", {
          treatmentId: treatment._id,
          services: stripClientKeys(reorderedServices),
        });
      } catch (err) {
        console.error("Failed to reorder services:", err);
        // rollback by refetching just in case
        fetchTreatments();
      }
    },
    [fetchTreatments],
  );

  /* ===================== RENDER ===================== */

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

          const sortableItems = (treatment.services || []).map((s) => s.__key);

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
                    <h2 className="text-2xl font-semibold break-words line-clamp-2">
                      {treatment.title}
                    </h2>
                    {/* Description */}
                    <p
                      className={`
                        text-foreground/70 mt-1
                        [overflow-wrap:anywhere]
                        ${expandedDesc === index ? "" : "line-clamp-3"}
                        md:line-clamp-none
                      `}
                    >
                      {treatment.description}
                    </p>
                    {treatment.description?.length > 100 && (
                      <button
                        onClick={() =>
                          setExpandedDesc(expandedDesc === index ? null : index)
                        }
                        className="md:hidden mt-2 text-sm text-primary underline"
                      >
                        {expandedDesc === index ? "إظهار أقل" : "اقرأ المزيد"}
                      </button>
                    )}
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
                          setServiceForm({ ...emptyService, __key: makeKey() });
                          setSelectedImage(null);
                        }}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg"
                      >
                        إضافة خدمة +
                      </button>
                    </div>

                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={(event) =>
                        handleServiceDragEnd(event, treatment)
                      }
                    >
                      <SortableContext
                        items={sortableItems}
                        strategy={verticalListSortingStrategy}
                      >
                        {/* ===== Desktop / Tablet: Table ===== */}
                        <div className="hidden md:block">
                          <div className="relative w-full overflow-x-auto rounded-xl border border-border">
                            <table className="w-full min-w-[900px] border-collapse bg-background">
                              <thead className="border-b border-border">
                                <tr className="border-b border-border">
                                  <th className="border p-2 w-10"></th>
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
                                  <SortableRow key={s.__key} id={s.__key}>
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
                                      <div className="max-w-[320px] break-words whitespace-normal text-sm">
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
                                          onClick={() =>
                                            setPreviewImage(s.imageUrl)
                                          }
                                          className="block"
                                        >
                                          <img
                                            src={s.imageUrl}
                                            alt={s.title}
                                            className="object-cover rounded-lg border border-border w-12 h-12 md:w-16 md:h-16"
                                          />
                                        </button>
                                      ) : (
                                        <span className="text-foreground/50">
                                          —
                                        </span>
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
                                                    __key: s.__key,
                                                    title: s.title ?? "",
                                                    description:
                                                      s.description ?? "",
                                                    duration: s.duration ?? "",
                                                    price: s.price ?? "",
                                                    currency:
                                                      s.currency ?? "ILS",
                                                    ...(hujama
                                                      ? {
                                                          cupsCount:
                                                            s.cupsCount ?? "",
                                                        }
                                                      : {}),
                                                    imageUrl: s.imageUrl ?? "",
                                                    imagePath:
                                                      s.imagePath ?? "",
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
                                  </SortableRow>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* ===== Mobile: Cards (no overflow, fully readable) ===== */}
                        <div className="md:hidden space-y-3">
                          {(treatment.services || []).map((s, i) => (
                            <SortableCard key={s.__key} id={s.__key}>
                              <div className="flex items-start gap-3">
                                <div className="flex-1">
                                  <div className="flex items-start justify-between gap-2">
                                    <div>
                                      <div className="font-semibold">
                                        {s.title}
                                      </div>
                                      <div className="text-sm text-foreground/70">
                                        {s.duration
                                          ? `${s.duration} دقيقة`
                                          : "—"}{" "}
                                        •{" "}
                                        {s.price
                                          ? `${s.price} ${s.currency}`
                                          : "—"}
                                      </div>
                                    </div>

                                    <button
                                      onClick={() =>
                                        setServiceMenu(
                                          serviceMenu === `${index}-${i}`
                                            ? null
                                            : `${index}-${i}`,
                                        )
                                      }
                                      className="p-2 border border-border rounded-lg shrink-0"
                                    >
                                      ⋮
                                    </button>
                                  </div>

                                  {s.description ? (
                                    <div className="text-sm mt-2 break-words whitespace-normal">
                                      {s.description}
                                    </div>
                                  ) : (
                                    <div className="text-sm mt-2 text-foreground/50">
                                      —
                                    </div>
                                  )}

                                  {hujama && (
                                    <div className="text-sm mt-2">
                                      <span className="text-foreground/70">
                                        عدد الكووس:{" "}
                                      </span>
                                      {s.cupsCount || "—"}
                                    </div>
                                  )}

                                  <div className="mt-3 flex items-center gap-3">
                                    {s.imageUrl ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setPreviewImage(s.imageUrl)
                                        }
                                      >
                                        <img
                                          src={s.imageUrl}
                                          alt={s.title}
                                          className="object-cover rounded-lg border border-border w-14 h-14"
                                        />
                                      </button>
                                    ) : (
                                      <div className="text-sm text-foreground/50">
                                        لا توجد صورة
                                      </div>
                                    )}
                                  </div>

                                  <AnimatePresence>
                                    {serviceMenu === `${index}-${i}` && (
                                      <motion.div
                                        initial={{ opacity: 0, y: -5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -5 }}
                                        className="mt-3 w-full bg-background border border-border rounded-xl shadow-lg overflow-hidden"
                                      >
                                        <button
                                          onClick={() => {
                                            setServiceEdit({
                                              treatmentId: treatment._id,
                                              index: i,
                                              isHujama: hujama,
                                            });
                                            setServiceForm({
                                              __key: s.__key,
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
                                          className="w-full text-left px-4 py-3 hover:bg-muted"
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
                                          className="w-full text-left px-4 py-3 text-destructive hover:bg-destructive/10"
                                        >
                                          حذف
                                        </button>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </div>
                              </div>
                            </SortableCard>
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* ===== Preview Image ===== */}
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

      {/* ===== Add Treatment Modal ===== */}
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
                setNewTreatment((p) => ({ ...p, description: e.target.value }))
              }
              className="border border-border bg-background text-foreground placeholder:text-foreground/50 px-3 py-2 rounded w-full mb-4 min-h-[110px]"
              style={{ WebkitTextFillColor: "var(--foreground)" }}
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowAddModal(false)}>Cancel</button>
              <button
                disabled={isAdding}
                onClick={addTreatment}
                className="bg-primary px-4 py-2 rounded text-white"
              >
                حفظ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Service Modal ===== */}
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
                  setServiceForm((p) => ({ ...p, cupsCount: e.target.value }))
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

            <div className="flex justify-end gap-3 pt-2 flex-wrap">
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

              {serviceForm.imageUrl && !selectedImage && (
                <button
                  type="button"
                  onClick={async () => {
                    await axios.post(
                      "/api/admin/treatments/services/delete-image",
                      {
                        treatmentId: serviceEdit.treatmentId,
                        serviceIndex: serviceEdit.index,
                      },
                    );

                    setServiceForm((p) => ({
                      ...p,
                      imageUrl: "",
                      imagePath: "",
                    }));
                  }}
                  className="text-sm text-destructive underline"
                >
                  حذف الصورة
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== Confirm Delete ===== */}
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
