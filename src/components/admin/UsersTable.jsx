import { useState } from "react";
import { motion } from "framer-motion";
import {
  Edit3,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Eye,
} from "lucide-react";
import { UserAvatar } from "./UserAvatar";
import { Button } from "@/components/ui/button";
import axios from "axios";

const USERS_PER_PAGE = 10;

export const UsersTable = ({ users, onViewAppointments }) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [editingUserId, setEditingUserId] = useState(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);
  const [editMobileUser, setEditMobileUser] = useState(null);

  const totalPages = Math.ceil(users.length / USERS_PER_PAGE);
  const startIndex = (currentPage - 1) * USERS_PER_PAGE;
  const endIndex = startIndex + USERS_PER_PAGE;
  const currentUsers = users.slice(startIndex, endIndex);

  const getLastAppointmentDate = (user) => {
    const pastAppointments = user.appointments.filter(
      (apt) => apt.date < new Date().toISOString().split("T")[0],
    );
    if (!pastAppointments.length) return "لا توجد مواعيد سابقة";
    const lastApt = pastAppointments[0];
    return new Date(lastApt.date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const startEdit = (user) => {
    setEditingUserId(user._id);
    setFirstName(user.firstName);
    setLastName(user.lastName);
  };

  const cancelEdit = () => {
    setEditingUserId(null);
    setFirstName("");
    setLastName("");
  };

  const saveEdit = async (userId) => {
    if (saving) return;

    try {
      setSaving(true);

      await axios.post("/api/admin/users", {
        userId,
        firstName,
        lastName,
      });

      users.forEach((u) => {
        if (u._id === userId) {
          u.firstName = firstName;
          u.lastName = lastName;
        }
      });

      cancelEdit();
    } catch (err) {
      console.error("Failed to update name", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card rounded-2xl shadow-card overflow-hidden">
      {/* Desktop */}
      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[16%]" />
            <col className="w-[12%]" />
            <col className="w-[20%]" />
            <col className="w-[14%]" />
          </colgroup>

          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="p-4 text-center text-sm font-semibold text-muted-foreground border-l border-border">
                الاسم
              </th>
              <th className="p-4 text-center text-sm font-semibold text-muted-foreground border-l border-border">
                المواعيد
              </th>
              <th className="p-4 text-center text-sm font-semibold text-muted-foreground border-l border-border">
                المجموع
              </th>
              <th className="p-4 text-center text-sm font-semibold text-muted-foreground border-l border-border">
                آخر موعد
              </th>
              <th className="p-4 text-center text-sm font-semibold text-muted-foreground">
                تعديل الاسم
              </th>
            </tr>
          </thead>

          <tbody>
            {currentUsers.map((user, index) => (
              <motion.tr
                key={user.phone}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.03 }}
                className="border-b border-border hover:bg-muted/30"
              >
                {/* Name */}
                <td className="p-4 border-l border-border align-middle">
                  <div className="flex gap-3 items-center">
                    <UserAvatar
                      firstName={user.firstName}
                      lastName={user.lastName}
                    />
                    <div className="w-full">
                      {editingUserId === user._id ? (
                        <div className="flex flex-col gap-2">
                          <input
                            className="w-full rounded px-2 py-1 text-sm
                            bg-background text-foreground
                            border border-border
                            placeholder:text-muted-foreground
                            focus:outline-none focus:ring-2 focus:ring-primary"
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            placeholder="الاسم الأول"
                          />
                          <input
                            className="w-full rounded px-2 py-1 text-sm
                            bg-background text-foreground
                            border border-border
                            placeholder:text-muted-foreground
                            focus:outline-none focus:ring-2 focus:ring-primary"
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            placeholder="اسم العائلة"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={saving}
                              onClick={() => saveEdit(user._id)}
                            >
                              {saving ? "جارٍ الحفظ..." : "حفظ"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={saving}
                              onClick={cancelEdit}
                            >
                              إلغاء
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="font-medium truncate">
                            {user.firstName} {user.lastName}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {user.phone}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </td>

                {/* Appointments */}
                <td className="p-4 text-center border-l border-border align-middle">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onViewAppointments(user)}
                    className="gap-2"
                  >
                    <Eye className="w-4 h-4" /> عرض المواعيد
                  </Button>
                </td>

                {/* Total */}
                <td className="p-4 text-center border-l border-border align-middle">
                  <span className="inline-flex gap-1.5 items-center px-2.5 py-1 rounded-full bg-muted text-sm">
                    <CalendarDays className="w-3.5 h-3.5" />
                    {user.appointments.length}
                  </span>
                </td>

                {/* Last appointment */}
                <td className="p-4 text-center text-sm text-muted-foreground border-l border-border align-middle whitespace-nowrap">
                  {getLastAppointmentDate(user)}
                </td>

                {/* Change name */}
                <td className="p-4 text-center align-middle">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving || editingUserId !== null}
                    onClick={() => startEdit(user)}
                  >
                    تغيير الاسم
                  </Button>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      {/* Mobile */}
      <div className="md:hidden divide-y divide-border">
        {currentUsers.map((user) => (
          <div key={user.phone} className="p-4 space-y-3">
            {/* Top row */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <UserAvatar
                  firstName={user.firstName}
                  lastName={user.lastName}
                  size="sm"
                />
                <div>
                  <p className="font-medium text-sm">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground">{user.phone}</p>
                </div>
              </div>
            </div>

            {/* Info row */}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <CalendarDays className="w-3.5 h-3.5" />
                آخر موعد: {getLastAppointmentDate(user)}
              </span>

              <span>المواعيد: {user.appointments.length}</span>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onViewAppointments(user)}
                className="flex-1 gap-1"
              >
                <Eye className="w-4 h-4" />
                عرض
              </Button>

              {/* Edit name */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditMobileUser(user);
                  startEdit(user);
                }}
                className="flex-1 gap-1"
              >
                <Edit3 className="w-4 h-4" />
                تعديل الاسم
              </Button>
            </div>
          </div>
        ))}
      </div>

      {editMobileUser && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card w-full max-w-sm rounded-2xl p-6 space-y-4">
            <h2 className="text-lg font-semibold text-center">تعديل الاسم</h2>

            <input
              className="w-full rounded px-3 py-2 text-sm
        bg-background text-foreground
        border border-border
        placeholder:text-muted-foreground
        focus:outline-none focus:ring-2 focus:ring-primary"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="الاسم الأول"
              autoFocus
            />

            <input
              className="w-full rounded px-3 py-2 text-sm
        bg-background text-foreground
        border border-border
        placeholder:text-muted-foreground
        focus:outline-none focus:ring-2 focus:ring-primary"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="اسم العائلة"
            />

            <div className="flex gap-2 pt-2">
              <Button
                className="flex-1"
                disabled={saving}
                onClick={() => {
                  saveEdit(editMobileUser._id);
                  setEditMobileUser(null);
                }}
              >
                {saving ? "جارٍ الحفظ..." : "حفظ"}
              </Button>

              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  cancelEdit();
                  setEditMobileUser(null);
                }}
              >
                إلغاء
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Pagination */}
      <div className="flex justify-between items-center p-4 border-t border-border bg-muted/30">
        <p className="text-sm text-muted-foreground">
          عرض {startIndex + 1}–{Math.min(endIndex, users.length)} من{" "}
          {users.length}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
