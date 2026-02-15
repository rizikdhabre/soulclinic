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

const emptyPerfume = {
  name: "",
  description: "",
  price: "",
  size: "",
  imageUrl: "",
  imagePath: "",
};

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
        >
          ⋮⋮
        </button>
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

function ReadMore({ text = "", limit = 80 }) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return "—";

  const isLong = text.length > limit;

  const displayText = expanded || !isLong ? text : text.slice(0, limit) + "...";

  return (
    <div
      className="
        text-sm
        break-words
        whitespace-pre-line
        overflow-hidden
      "
    >
      {displayText}

      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-primary mr-2 underline text-xs inline"
        >
          {expanded ? " عرض أقل" : " عرض المزيد"}
        </button>
      )}
    </div>
  );
}

export default function AdminPerfumesPage() {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );

  const [categories, setCategories] = useState([]);
  const [openIndex, setOpenIndex] = useState(null);
  const [menuIndex, setMenuIndex] = useState(null);
  const [perfumeMenu, setPerfumeMenu] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [loading, setLoading] = useState(true);

  const [editingIndex, setEditingIndex] = useState(null);
  const [editedName, setEditedName] = useState("");
  const [editedDescription, setEditedDescription] = useState("");

  const [perfumeEdit, setPerfumeEdit] = useState(null);
  const [perfumeForm, setPerfumeForm] = useState(emptyPerfume);
  const [selectedImage, setSelectedImage] = useState(null);

  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newCategory, setNewCategory] = useState({
    name: "",
    description: "",
  });

  const [confirmDelete, setConfirmDelete] = useState(null);

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/admin/perfumes");
      setCategories(res.data || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const addCategory = useCallback(async () => {
    if (isAdding || !newCategory.name.trim()) return;
    setIsAdding(true);
    try {
      const res = await axios.post("/api/admin/perfumes", newCategory);
      setCategories((prev) => [
        ...prev,
        {
          _id: res.data.id,
          name: newCategory.name,
          description: newCategory.description,
          perfumes: [],
        },
      ]);
      setShowAddModal(false);
      setNewCategory({ name: "", description: "" });
    } finally {
      setIsAdding(false);
    }
  }, [isAdding, newCategory]);

  const saveCategory = useCallback(
    async (id) => {
      if (isSaving) return;
      const backup = categories.find((c) => c._id === id);

      setCategories((prev) =>
        prev.map((c) =>
          c._id === id
            ? { ...c, name: editedName, description: editedDescription }
            : c,
        ),
      );

      setEditingIndex(null);
      setIsSaving(true);

      try {
        await axios.put("/api/admin/perfumes", {
          id,
          name: editedName,
          description: editedDescription,
        });
      } catch {
        setCategories((prev) => prev.map((c) => (c._id === id ? backup : c)));
      } finally {
        setIsSaving(false);
      }
    },
    [isSaving, categories, editedName, editedDescription],
  );

  const confirmDeleteCategory = useCallback(async () => {
    if (isDeleting || !confirmDelete?.id) return;
    const backup = categories.find((c) => c._id === confirmDelete.id);

    setCategories((prev) => prev.filter((c) => c._id !== confirmDelete.id));
    setConfirmDelete(null);
    setIsDeleting(true);

    try {
      await axios.delete("/api/admin/perfumes", {
        data: { id: backup._id },
      });
    } catch {
      setCategories((prev) => [...prev, backup]);
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, confirmDelete, categories]);

  const uploadImage = useCallback(
    async (categoryId) => {
      const formData = new FormData();
      formData.append("image", selectedImage);
      formData.append("categoryId", categoryId);
      const res = await axios.post(
        "/api/admin/perfumes/upload-image",
        formData,
      );
      return res.data;
    },
    [selectedImage],
  );

  const savePerfume = useCallback(async () => {
    if (!perfumeEdit || isSaving) return;
    setIsSaving(true);

    let imageData = {
      url: perfumeForm.imageUrl,
      path: perfumeForm.imagePath,
    };

    try {
      if (selectedImage) {
        imageData = await uploadImage(perfumeEdit.categoryId);
      }

      if (!perfumeEdit.perfumeId) {
        const res = await axios.post("/api/admin/perfumes/sub", {
          categoryId: perfumeEdit.categoryId,
          perfume: {
            ...perfumeForm,
            imageUrl: imageData.url,
            imagePath: imageData.path,
          },
        });

        setCategories((prev) =>
          prev.map((c) =>
            c._id === perfumeEdit.categoryId
              ? { ...c, perfumes: [...(c.perfumes || []), res.data] }
              : c,
          ),
        );
      } else {
        await axios.put("/api/admin/perfumes/sub", {
          categoryId: perfumeEdit.categoryId,
          perfumeId: perfumeEdit.perfumeId,
          perfume: {
            ...perfumeForm,
            imageUrl: imageData.url,
            imagePath: imageData.path,
          },
        });

        setCategories((prev) =>
          prev.map((c) =>
            c._id === perfumeEdit.categoryId
              ? {
                  ...c,
                  perfumes: (c.perfumes || []).map((p) =>
                    p._id === perfumeEdit.perfumeId
                      ? {
                          ...p,
                          ...perfumeForm,
                          imageUrl: imageData.url,
                          imagePath: imageData.path,
                        }
                      : p,
                  ),
                }
              : c,
          ),
        );
      }

      setPerfumeEdit(null);
      setPerfumeForm(emptyPerfume);
      setSelectedImage(null);
      setPerfumeMenu(null);
    } finally {
      setIsSaving(false);
    }
  }, [perfumeEdit, perfumeForm, selectedImage, uploadImage, isSaving]);

  const confirmDeletePerfume = useCallback(async () => {
    if (isDeleting) return;

    const { categoryId, perfumeId } = confirmDelete || {};
    if (!categoryId || !perfumeId) return;

    const backupCategory = categories.find((c) => c._id === categoryId);
    const backupPerfume = backupCategory?.perfumes?.find(
      (p) => p._id === perfumeId,
    );

    setCategories((prev) =>
      prev.map((c) =>
        c._id === categoryId
          ? {
              ...c,
              perfumes: (c.perfumes || []).filter((p) => p._id !== perfumeId),
            }
          : c,
      ),
    );

    setConfirmDelete(null);
    setIsDeleting(true);

    try {
      await axios.delete("/api/admin/perfumes/sub", {
        data: { categoryId, perfumeId },
      });
    } catch {
      setCategories((prev) =>
        prev.map((c) =>
          c._id === categoryId
            ? {
                ...c,
                perfumes: [...(c.perfumes || []), backupPerfume],
              }
            : c,
        ),
      );
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, confirmDelete, categories]);

  const handleDragEnd = useCallback(
    async (event, category) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const perfumes = category.perfumes || [];
      const oldIndex = perfumes.findIndex((p) => p._id === active.id);
      const newIndex = perfumes.findIndex((p) => p._id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(perfumes, oldIndex, newIndex);

      setCategories((prev) =>
        prev.map((c) =>
          c._id === category._id ? { ...c, perfumes: reordered } : c,
        ),
      );

      try {
        await axios.put("/api/admin/perfumes/reorder", {
          categoryId: category._id,
          order: reordered.map((p) => p._id),
        });
      } catch {
        fetchCategories();
      }
    },
    [fetchCategories],
  );

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
        <h1 className="text-4xl font-bold">العطور</h1>
        <button
          onClick={() => setShowAddModal(true)}
          disabled={isAdding}
          className="px-5 py-2 rounded-xl bg-primary text-primary-foreground"
        >
          إضافة فئة +
        </button>
      </div>

      <div className="space-y-6">
        {categories.map((category, index) => {
          const isOpen = openIndex === index;
          const sortableItems = (category.perfumes || []).map((p) => p._id);

          return (
            <div
              key={category._id}
              className="border border-border rounded-2xl bg-background"
            >
              <div className="flex justify-between items-start p-6">
                {editingIndex === index ? (
                  <div className="flex flex-col gap-3 w-full mr-4">
                    <div className="flex gap-2">
                      <input
                        value={editedName}
                        onChange={(e) => setEditedName(e.target.value)}
                        className="border border-border bg-background px-3 py-2 rounded-md w-full"
                      />
                      <button
                        onClick={() => saveCategory(category._id)}
                        className="px-4 py-2 rounded-lg bg-green-600 text-white"
                      >
                        حفظ
                      </button>
                    </div>

                    <textarea
                      value={editedDescription}
                      onChange={(e) => setEditedDescription(e.target.value)}
                      className="border border-border bg-background px-3 py-2 rounded-md w-full min-h-[80px]"
                    />
                  </div>
                ) : (
                  <div className="w-full">
                    <h2 className="text-2xl font-semibold">{category.name}</h2>
                    <div className="text-foreground/70 mt-1 max-w-[700px]">
                      <ReadMore text={category.description} limit={120} />
                    </div>
                  </div>
                )}

                <div className="relative ml-4 z-50">
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
                            setEditedName(category.name);
                            setEditedDescription(category.description);
                            setMenuIndex(null);
                          }}
                          className="w-full text-left px-4 py-2 hover:bg-muted"
                        >
                          تعديل
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
                          onClick={() => {
                            setConfirmDelete({
                              type: "category",
                              id: category._id,
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
                        onClick={() => {
                          setPerfumeEdit({
                            categoryId: category._id,
                            perfumeId: null,
                          });
                          setPerfumeForm(emptyPerfume);
                          setSelectedImage(null);
                        }}
                        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg"
                      >
                        إضافة عطر +
                      </button>
                    </div>

                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={(event) => handleDragEnd(event, category)}
                    >
                      <SortableContext
                        items={sortableItems}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="hidden md:block">
                          <div className="relative w-full overflow-x-auto rounded-xl border border-border">
                            <table className="w-full min-w-[1000px] border-collapse bg-background">
                              <thead>
                                <tr>
                                  <th className="border p-2 w-10"></th>
                                  <th className="border p-2">الاسم</th>
                                  <th className="border p-2">الوصف</th>
                                  <th className="border p-2">السعر</th>
                                  <th className="border p-2">الحجم</th>
                                  <th className="border p-2">الصورة</th>
                                  <th className="border p-2">الإجراءات</th>
                                </tr>
                              </thead>

                              <tbody>
                                {(category.perfumes || []).map((p) => (
                                  <SortableRow key={p._id} id={p._id}>
                                    <td className="border p-2">{p.name}</td>
                                    <td className="border p-2">
                                      <div className="max-w-[320px] break-all whitespace-normal">
                                        <ReadMore text={p.description} />
                                      </div>
                                    </td>
                                    <td className="border p-2">{p.price}</td>
                                    <td className="border p-2">{p.size} ml</td>
                                    <td className="border p-2">
                                      {p.imageUrl ? (
                                        <button
                                          onClick={() =>
                                            setPreviewImage(p.imageUrl)
                                          }
                                        >
                                          <img
                                            src={p.imageUrl}
                                            className="w-16 h-16 object-cover rounded"
                                          />
                                        </button>
                                      ) : (
                                        "—"
                                      )}
                                    </td>
                                    <td className="relative border p-2 text-right z-50">
                                      <button
                                        onClick={() =>
                                          setPerfumeMenu(
                                            perfumeMenu === p._id
                                              ? null
                                              : p._id,
                                          )
                                        }
                                        className="p-2 border border-border rounded-lg"
                                      >
                                        ⋮
                                      </button>

                                      <AnimatePresence>
                                        {perfumeMenu === p._id && (
                                          <motion.div
                                            initial={{
                                              opacity: 0,
                                              y: -5,
                                            }}
                                            animate={{
                                              opacity: 1,
                                              y: 0,
                                            }}
                                            exit={{
                                              opacity: 0,
                                              y: -5,
                                            }}
                                            className="absolute end-0 mt-2 w-32 bg-background border border-border rounded-xl shadow-lg z-[9999]"
                                          >
                                            <button
                                              onClick={() => {
                                                setPerfumeEdit({
                                                  categoryId: category._id,
                                                  perfumeId: p._id,
                                                });
                                                setPerfumeForm({
                                                  name: p.name || "",
                                                  description:
                                                    p.description || "",
                                                  price: p.price || "",
                                                  size: p.size || "",
                                                  imageUrl: p.imageUrl || "",
                                                  imagePath: p.imagePath || "",
                                                });
                                                setSelectedImage(null);
                                                setPerfumeMenu(null);
                                              }}
                                              className="w-full text-left px-4 py-2 hover:bg-muted"
                                            >
                                              تعديل
                                            </button>

                                            <button
                                              onClick={() => {
                                                setConfirmDelete({
                                                  type: "perfume",
                                                  categoryId: category._id,
                                                  perfumeId: p._id,
                                                });
                                                setPerfumeMenu(null);
                                              }}
                                              className="w-full text-left px-4 py-2 text-destructive hover:bg-destructive/10"
                                            >
                                              حذف
                                            </button>
                                          </motion.div>
                                        )}
                                      </AnimatePresence>
                                    </td>
                                  </SortableRow>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        <div className="md:hidden space-y-3">
                          {(category.perfumes || []).map((p) => (
                            <SortableCard key={p._id} id={p._id}>
                              <div className="flex items-start justify-between">
                                <div>
                                  <div className="font-semibold">{p.name}</div>
                                  <div className="text-sm mt-1 break-words whitespace-normal text-foreground/70">
                                    <ReadMore text={p.description} />
                                  </div>
                                  <div className="text-sm text-foreground/70">
                                    {p.price} • {p.size} ml
                                  </div>
                                </div>

                                <button
                                  onClick={() =>
                                    setPerfumeMenu(
                                      perfumeMenu === p._id ? null : p._id,
                                    )
                                  }
                                  className="p-2 border border-border rounded-lg"
                                >
                                  ⋮
                                </button>
                              </div>

                              <div className="mt-3">
                                {p.imageUrl ? (
                                  <img
                                    src={p.imageUrl}
                                    onClick={() => setPreviewImage(p.imageUrl)}
                                    className="w-14 h-14 object-cover rounded"
                                  />
                                ) : (
                                  <div className="text-sm text-foreground/50">
                                    لا توجد صورة
                                  </div>
                                )}
                              </div>

                              <AnimatePresence>
                                {perfumeMenu === p._id && (
                                  <motion.div
                                    initial={{
                                      opacity: 0,
                                      y: -5,
                                    }}
                                    animate={{
                                      opacity: 1,
                                      y: 0,
                                    }}
                                    exit={{
                                      opacity: 0,
                                      y: -5,
                                    }}
                                    className="mt-3 w-full bg-background border border-border rounded-xl shadow-lg overflow-hidden"
                                  >
                                    <button
                                      onClick={() => {
                                        setPerfumeEdit({
                                          categoryId: category._id,
                                          perfumeId: p._id,
                                        });
                                        setPerfumeForm({
                                          name: p.name || "",
                                          description: p.description || "",
                                          price: p.price || "",
                                          size: p.size || "",
                                          imageUrl: p.imageUrl || "",
                                          imagePath: p.imagePath || "",
                                        });
                                        setSelectedImage(null);
                                        setPerfumeMenu(null);
                                      }}
                                      className="w-full text-left px-4 py-3 hover:bg-muted"
                                    >
                                      تعديل
                                    </button>

                                    <button
                                      onClick={() => {
                                        setConfirmDelete({
                                          type: "perfume",
                                          categoryId: category._id,
                                          perfumeId: p._id,
                                        });
                                        setPerfumeMenu(null);
                                      }}
                                      className="w-full text-left px-4 py-3 text-destructive hover:bg-destructive/10"
                                    >
                                      حذف
                                    </button>
                                  </motion.div>
                                )}
                              </AnimatePresence>
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

      {previewImage && (
        <div
          className="fixed inset-0 z-[99999] bg-black/80 flex items-center justify-center"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            className="max-w-[90vw] max-h-[90vh] rounded-xl border border-border bg-background"
          />
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-background p-6 rounded-xl">
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)}>إلغاء</button>
              <button
                onClick={
                  confirmDelete.type === "category"
                    ? confirmDeleteCategory
                    : confirmDeletePerfume
                }
                className="bg-destructive px-4 py-2 rounded text-white"
              >
                حذف
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-background p-6 rounded-2xl w-full max-w-lg">
            <input
              placeholder="اسم الفئة"
              value={newCategory.name}
              onChange={(e) =>
                setNewCategory((p) => ({
                  ...p,
                  name: e.target.value,
                }))
              }
              className="border border-border bg-background px-3 py-2 rounded w-full mb-3"
            />
            <textarea
              placeholder="الوصف"
              value={newCategory.description}
              onChange={(e) =>
                setNewCategory((p) => ({
                  ...p,
                  description: e.target.value,
                }))
              }
              className="border border-border bg-background px-3 py-2 rounded w-full mb-4 min-h-[110px]"
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowAddModal(false)}>إلغاء</button>
              <button
                disabled={isAdding}
                onClick={addCategory}
                className="bg-primary px-4 py-2 rounded text-white"
              >
                حفظ
              </button>
            </div>
          </div>
        </div>
      )}

      {perfumeEdit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-background p-6 rounded-2xl w-full max-w-lg space-y-3">
            <input
              placeholder="اسم العطر"
              value={perfumeForm.name}
              onChange={(e) =>
                setPerfumeForm((p) => ({
                  ...p,
                  name: e.target.value,
                }))
              }
              className="border border-border bg-background px-3 py-2 rounded-md w-full"
            />
            <textarea
              placeholder="الوصف"
              value={perfumeForm.description}
              onChange={(e) =>
                setPerfumeForm((p) => ({
                  ...p,
                  description: e.target.value,
                }))
              }
              className="border border-border bg-background px-3 py-2 rounded-md w-full min-h-[110px]"
            />
            <input
              placeholder="السعر"
              type="number"
              value={perfumeForm.price}
              onChange={(e) =>
                setPerfumeForm((p) => ({
                  ...p,
                  price: e.target.value,
                }))
              }
              className="border border-border bg-background px-3 py-2 rounded-md w-full"
            />
            <input
              placeholder="الحجم (ml)"
              type="number"
              value={perfumeForm.size}
              onChange={(e) =>
                setPerfumeForm((p) => ({
                  ...p,
                  size: e.target.value,
                }))
              }
              className="border border-border bg-background px-3 py-2 rounded-md w-full"
            />

            <input
              type="file"
              accept="image/*"
              onChange={(e) => setSelectedImage(e.target.files?.[0] || null)}
            />

            {(selectedImage || perfumeForm.imageUrl) && (
              <img
                src={
                  selectedImage
                    ? URL.createObjectURL(selectedImage)
                    : perfumeForm.imageUrl
                }
                className="w-32 h-32 object-cover rounded-xl border border-border"
              />
            )}

            <div className="flex justify-end gap-3 flex-wrap">
              <button
                onClick={() => {
                  setPerfumeEdit(null);
                  setPerfumeForm(emptyPerfume);
                  setSelectedImage(null);
                }}
              >
                إلغاء
              </button>

              <button
                onClick={savePerfume}
                disabled={isSaving}
                className="bg-primary px-4 py-2 rounded text-white"
              >
                حفظ
              </button>

              {perfumeForm.imageUrl &&
                !selectedImage &&
                perfumeEdit.perfumeId && (
                  <button
                    onClick={async () => {
                      await axios.post("/api/admin/perfumes/delete-image", {
                        categoryId: perfumeEdit.categoryId,
                        perfumeId: perfumeEdit.perfumeId,
                      });

                      setPerfumeForm((p) => ({
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
    </div>
  );
}
