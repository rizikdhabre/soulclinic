"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Phone, Calendar, Clock } from "lucide-react";
import { UserAvatar } from "./UserAvatar";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import axios from "axios";

export const AppointmentsModal = ({
  user,
  isOpen,
  onClose,
  onToggleAttendance,
  onCancelAppointment,
  onUpdateAdminNotes,
}) => {
  const [activeAppointment, setActiveAppointment] = useState(null);
  const [adminNotes, setAdminNotes] = useState(user.adminNotes || []);
  const [newNote, setNewNote] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");
  const [appointments, setAppointments] = useState(user.appointments || []);

  useEffect(() => {
    setAppointments(user.appointments || []);
  }, [user.appointments]);
  const addAdminNote = async () => {
    if (!newNote.trim()) return;

    try {
      const res = await axios.post("/api/admin/admin-notes", {
        phone: user.phone,
        text: newNote,
      });

      const updated = [...adminNotes, res.data];

      setAdminNotes(updated);
      onUpdateAdminNotes(user.phone, updated);
      setNewNote("");
    } catch (err) {
      console.error("Failed to add admin note", err);
    }
  };

  const saveEdit = async (noteId) => {
    try {
      await axios.put("/api/admin/admin-notes", {
        phone: user.phone,
        noteId,
        text: editingText,
      });

      const updated = adminNotes.map((n) =>
        n.id === noteId ? { ...n, text: editingText } : n,
      );

      setAdminNotes(updated);
      onUpdateAdminNotes(user.phone, updated);

      setEditingId(null);
      setEditingText("");
    } catch (err) {
      console.error("Failed to edit admin note", err);
    }
  };

  const deleteAdminNote = async (noteId) => {
    try {
      await axios.delete("/api/admin/admin-notes", {
        data: {
          phone: user.phone,
          noteId,
        },
      });

      const updated = adminNotes.filter((n) => n.id !== noteId);

      setAdminNotes(updated);
      onUpdateAdminNotes(user.phone, updated);
    } catch (err) {
      console.error("Failed to delete admin note", err);
    }
  };

  const appointmentNotes = activeAppointment
    ? user.notes?.filter(
        (n) =>
          n.date === activeAppointment.date &&
          n.time === activeAppointment.time,
      )
    : [];

  const today = new Date().toISOString().split("T")[0];

  const getStatus = (date) => {
    if (date < today) return "past";
    if (date === today) return "today";
    return "future";
  };

  useEffect(() => {
    setAdminNotes(user.adminNotes || []);
  }, [user]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => {
              setActiveAppointment(null);
              onClose();
            }}
          />

          {/* Modal Wrapper */}
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {/* Modal */}
            <motion.div
              initial={{ scale: 0.96, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 20 }}
              transition={{ type: "spring", stiffness: 260, damping: 24 }}
              className="
                w-full max-w-3xl max-h-[90dvh]
                bg-card rounded-2xl shadow-2xl
                flex flex-col overflow-hidden
                border border-border
              "
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-4 border-b border-border">
                <div className="flex items-center gap-3">
                  <UserAvatar
                    firstName={user.firstName}
                    lastName={user.lastName}
                    size="md"
                  />
                  <div>
                    <h2 className="text-base font-semibold text-foreground">
                      {user.firstName} {user.lastName}
                    </h2>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Phone className="w-3.5 h-3.5" />
                      {user.phone}
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => {
                    setActiveAppointment(null);
                    onClose();
                  }}
                  className="p-2 rounded-lg hover:bg-muted transition"
                >
                  <X className="w-5 h-5 text-muted-foreground" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-4 space-y-4 overscroll-contain">
                <AnimatePresence mode="popLayout">
                  {user.appointments.map((apt) => {
                    const status = getStatus(apt.date);

                    return (
                      <motion.div
                        key={apt._id}
                        layout
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        transition={{ duration: 0.25, ease: "easeInOut" }}
                        onClick={() => setActiveAppointment(apt)}
                        className={cn(
                          "rounded-xl border p-4 transition-all cursor-pointer hover:shadow-md",
                          status === "past" && "bg-muted/40",
                          status === "today" &&
                            "bg-primary/5 border-primary/30",
                          status === "future" &&
                            "bg-card hover:border-primary/30",
                        )}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                          {/* Date / Time */}
                          <div className="flex items-center gap-4 sm:w-52">
                            <div>
                              <p className="flex items-center gap-1.5 text-sm md:text-base font-medium">
                                <Calendar className="w-4 h-4 text-muted-foreground" />
                                {apt.date}
                              </p>
                              <p className="flex items-center gap-1.5 text-sm md:text-base text-muted-foreground">
                                <Clock className="w-4 h-4" />
                                {apt.time}
                              </p>
                            </div>

                            {status === "today" && (
                              <span className="px-2 py-0.5 text-xs rounded-full bg-primary text-primary-foreground">
                                Today
                              </span>
                            )}
                          </div>

                          {/* Service */}
                          <div className="flex-1">
                            <p className="font-medium text-foreground text-sm md:text-base">
                              {apt.title}
                            </p>
                            <p className="flex items-center gap-1 text-sm md:text-base text-muted-foreground">
                              <span className="text-2xl font-bold">₪</span>
                              {apt.price}
                            </p>
                          </div>

                          {/* Actions */}
                          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                            {status !== "future" && (
                              <>
                                <Switch
                                  checked={apt.attended}
                                  onCheckedChange={(v) =>
                                    onToggleAttendance(apt._id, v)
                                  }
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <span
                                  className={cn(
                                    "text-sm md:text-base font-medium",
                                    apt.attended
                                      ? "text-success"
                                      : "text-destructive",
                                  )}
                                >
                                  {apt.attended ? "Attended" : "Did not attend"}
                                </span>
                              </>
                            )}

                            {status === "future" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:bg-destructive/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAppointments((prev) =>
                                    prev.filter(
                                      (a) => String(a._id) !== String(apt._id),
                                    ),
                                  );

                                  // backend + parent sync
                                  onCancelAppointment(apt._id);
                                }}
                              >
                                الغاء الموعد
                              </Button>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>

                {/* NOTES (INSIDE SCROLL) */}
                {activeAppointment && (
                  <div className="mt-4 border-t border-border pt-4 bg-muted/30 rounded-xl">
                    <div className="flex items-start justify-between mb-3">
                      <h3 className="text-sm font-semibold text-foreground break-words pr-6">
                        Notes · {activeAppointment.title} —{" "}
                        {activeAppointment.date} {activeAppointment.time}
                      </h3>

                      <button
                        onClick={() => setActiveAppointment(null)}
                        className="p-1 rounded-md text-muted-foreground hover:bg-muted transition"
                        aria-label="Close notes"
                      >
                        ✕
                      </button>
                    </div>

                    {appointmentNotes.length > 0 ? (
                      <div className="space-y-2">
                        {appointmentNotes.map((note, idx) => (
                          <div
                            key={idx}
                            className="rounded-lg border bg-card p-3 text-sm"
                          >
                            <p className="text-foreground">{note.text}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                      لا توجد ملاحظات لهذا الموعد
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* ADMIN NOTES */}
              <div className="mt-8 border-t border-border pt-6">
                <h3 className="text-sm md:text-base font-semibold text-foreground mb-3">
                 ملاحظات الإدارة
                </h3>

                {/* Add note */}
                <div className="flex gap-2 mb-4">
                  <textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder="اكتب ملاحظة خاصة بالإدارة…"
                    rows={2}
                    className="
        flex-1 resize-none rounded-xl
        bg-muted/40 border border-border
        px-4 py-2 text-sm text-foreground
        placeholder:text-muted-foreground
        focus:outline-none focus:ring-2 focus:ring-primary/40
      "
                  />
                  <Button
                    size="sm"
                    className="h-auto px-4 rounded-xl"
                    onClick={addAdminNote}
                  >
                    إضافة
                  </Button>
                </div>

                {/* Notes list */}
                <div className="space-y-3">
                  {adminNotes.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">
                    لا توجد ملاحظات إدارية بعد
                    </p>
                  )}

                  {adminNotes.map((note) => (
                    <div
                      key={note.id}
                      className="
          rounded-xl border border-border
          bg-card p-4
        "
                    >
                      {editingId === note.id ? (
                        <>
                          <textarea
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            rows={3}
                            className="
                w-full resize-none rounded-lg
                bg-muted/40 border border-border
                px-3 py-2 text-sm text-foreground
                focus:outline-none focus:ring-2 focus:ring-primary/40
              "
                          />
                          <div className="flex gap-2 mt-3">
                            <Button size="sm" onClick={() => saveEdit(note.id)}>
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p className="text-sm md:text-base text-foreground leading-relaxed whitespace-pre-wrap">
                            {note.text}
                          </p>

                          <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
                            <button
                              onClick={() => {
                                setEditingId(note.id);
                                setEditingText(note.text);
                              }}
                              className="text-sm md:text-xxl hover:text-foreground transition"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => deleteAdminNote(note.id)}
                              className=" text-sm md:text-xxl hover:text-destructive transition"
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Footer */}
              <div className="border-t border-border px-4 py-3 text-center text-sm text-muted-foreground bg-muted/30">
                 إجمالي المواعيد: {user.appointments.length} 
              </div>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
