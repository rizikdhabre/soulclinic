import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, CalendarDays, Eye } from "lucide-react";
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
      <div className="md:hidden divide-y divide-border">
        {currentUsers.map((user) => (
          <div
            key={user.phone}
            className="p-4 flex items-center justify-between gap-4"
          >
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
                <p className="text-xs text-muted-foreground">
                  المواعيد: {user.appointments.length}
                </p>
              </div>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={() => onViewAppointments(user)}
              className="shrink-0"
            >
              <Eye className="w-4 h-4" />
            </Button>
          </div>
        ))}
      </div>

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
