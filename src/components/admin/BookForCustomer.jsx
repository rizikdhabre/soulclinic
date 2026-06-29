"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeIsraeliPhone } from "@/lib/phone";

const HUJAMA_ID = "69dbaf697f07ea94b798a89f";

const initialForm = {
  phone: "",
  firstName: "",
  lastName: "",
  date: "",
  time: "",
  note: "",
};

const initialCustomer = {
  status: "idle",
  lookupPhone: "",
  name: "",
};

function getTreatmentId(treatment) {
  return String(treatment?._id || "");
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export default function BookForCustomer() {
  const [form, setForm] = useState(initialForm);
  const [customer, setCustomer] = useState(initialCustomer);
  const [treatments, setTreatments] = useState([]);
  const [categoryId, setCategoryId] = useState("");
  const [serviceIndex, setServiceIndex] = useState("");
  const [loadingTreatments, setLoadingTreatments] = useState(true);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const submitInFlightRef = useRef(false);

  const normalizedPhone = normalizeIsraeliPhone(form.phone);

  const selectedCategory = useMemo(
    () =>
      treatments.find((treatment) => getTreatmentId(treatment) === categoryId),
    [categoryId, treatments],
  );

  const selectedService = useMemo(() => {
    if (!selectedCategory || serviceIndex === "") return null;
    return selectedCategory.services?.[Number(serviceIndex)] || null;
  }, [selectedCategory, serviceIndex]);

  const isHujama = categoryId === HUJAMA_ID;
  const isExistingCustomer =
    customer.status === "existing" &&
    customer.lookupPhone === normalizedPhone &&
    customer.name;

  useEffect(() => {
    const fetchTreatments = async () => {
      try {
        setLoadingTreatments(true);
        const response = await fetch("/api/admin/treatments", {
          cache: "no-store",
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "فشل تحميل الأقسام");
        }

        setTreatments(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error("Failed to load treatments:", error);
        showMessage("error", "فشل تحميل الأقسام");
      } finally {
        setLoadingTreatments(false);
      }
    };

    fetchTreatments();
  }, []);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));

    if (field === "phone") {
      setCustomer(initialCustomer);
    }
  };

  const showMessage = (type, text) => {
    setMessageType(type);
    setMessage(text);
  };

  const lookupCustomer = async () => {
    const phone = normalizeIsraeliPhone(form.phone);

    if (!phone) {
      showMessage("error", "أدخل رقم هاتف إسرائيلي صحيح.");
      setCustomer(initialCustomer);
      return null;
    }

    setLookupLoading(true);
    setMessage("");

    try {
      const response = await fetch(
        `/api/appointments/user?phone=${encodeURIComponent(phone)}`,
        { cache: "no-store" },
      );

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message || "فشل البحث عن الزبون");
      }

      const firstName = payload.firstName || "";
      const lastName = payload.lastName || "";
      const fullName = `${firstName} ${lastName}`.trim();

      setForm((current) => ({
        ...current,
        phone,
        firstName: payload.exists && firstName ? firstName : current.firstName,
        lastName: payload.exists && lastName ? lastName : current.lastName,
      }));

      if (payload.exists && firstName && lastName) {
        setCustomer({
          status: "existing",
          lookupPhone: phone,
          name: fullName,
        });
        showMessage("info", `هذا الرقم مسجل باسم: ${fullName}`);
        return { exists: true, firstName, lastName, phone };
      }

      setCustomer({
        status: "new",
        lookupPhone: phone,
        name: "",
      });
      showMessage("info", "هذا رقم جديد، أدخل الاسم الأول واسم العائلة");
      return { exists: false, firstName: "", lastName: "", phone };
    } catch (error) {
      console.error("Customer lookup failed:", error);
      setCustomer(initialCustomer);
      showMessage("error", error.message || "فشل البحث عن الزبون");
      return null;
    } finally {
      setLookupLoading(false);
    }
  };

  const handleCategoryChange = (value) => {
    setCategoryId(value);
    setServiceIndex("");
  };

  const resetForm = () => {
    setForm(initialForm);
    setCustomer(initialCustomer);
    setCategoryId("");
    setServiceIndex("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (submitting || submitInFlightRef.current) return;

    submitInFlightRef.current = true;
    setSubmitting(true);

    try {
      const phone = normalizeIsraeliPhone(form.phone);

      if (!phone) {
        showMessage("error", "أدخل رقم هاتف إسرائيلي صحيح.");
        return;
      }

      let customerResult = null;

      if (customer.lookupPhone !== phone) {
        customerResult = await lookupCustomer();
        if (!customerResult) return;
      }

      const resolvedExisting =
        customerResult?.exists ||
        (customer.status === "existing" && customer.lookupPhone === phone);

      if (
        !resolvedExisting &&
        (!form.firstName.trim() || !form.lastName.trim())
      ) {
        showMessage("error", "أدخل الاسم الأول واسم العائلة.");
        return;
      }

      if (!categoryId) {
        showMessage("error", "اختر القسم.");
        return;
      }

      if (!selectedService) {
        showMessage("error", "اختر العلاج.");
        return;
      }

      if (!form.date || !form.time) {
        showMessage("error", "أدخل التاريخ والساعة قبل حفظ الموعد.");
        return;
      }

      const payload = {
        phone,
        firstName: resolvedExisting
          ? customerResult?.firstName || form.firstName
          : form.firstName.trim(),
        lastName: resolvedExisting
          ? customerResult?.lastName || form.lastName
          : form.lastName.trim(),
        date: form.date,
        time: form.time,
        duration: selectedService.duration,
        title: selectedService.title,
        price: selectedService.price,
        note: form.note.trim(),
        ...(isHujama && hasValue(selectedService.cupsCount)
          ? { cupsCount: Number(selectedService.cupsCount) }
          : {}),
      };

      setMessage("");

      const response = await fetch("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || result.message || "فشل إنشاء الموعد");
      }

      resetForm();
      showMessage("success", "تم إنشاء الموعد بنجاح");
      window.dispatchEvent(new CustomEvent("appointments:changed"));
    } catch (error) {
      console.error("Admin booking failed:", error);
      showMessage("error", error.message || "فشل إنشاء الموعد");
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form
      dir="rtl"
      onSubmit={handleSubmit}
      className="rounded-2xl bg-card border border-border p-6 shadow-sm"
    >
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-foreground">
          حجز موعد لزبون
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <label className="space-y-2">
          <span className="text-sm font-medium text-foreground">
            رقم الهاتف
          </span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={form.phone}
            onChange={(event) => updateField("phone", event.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            required
          />
        </label>

        <div className="flex items-end">
          <button
            type="button"
            onClick={lookupCustomer}
            disabled={lookupLoading || submitting}
            className="w-full rounded-xl bg-secondary px-4 py-3 text-sm font-semibold text-foreground transition hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {lookupLoading ? "جارٍ البحث..." : "بحث عن الزبون"}
          </button>
        </div>

        {isExistingCustomer && (
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">الزبون الحالي</div>
            <div className="mt-1 text-sm font-semibold text-foreground">
              {customer.name}
            </div>
          </div>
        )}

        {!isExistingCustomer && (
          <>
            <label className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                الاسم الأول
              </span>
              <input
                value={form.firstName}
                onChange={(event) =>
                  updateField("firstName", event.target.value)
                }
                className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                required
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                اسم العائلة
              </span>
              <input
                value={form.lastName}
                onChange={(event) => updateField("lastName", event.target.value)}
                className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                required
              />
            </label>
          </>
        )}

        <label className="space-y-2">
          <span className="text-sm font-medium text-foreground">
            اختر القسم
          </span>
          <select
            value={categoryId}
            onChange={(event) => handleCategoryChange(event.target.value)}
            disabled={loadingTreatments}
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
            required
          >
            <option value="">
              {loadingTreatments ? "جارٍ تحميل الأقسام..." : "اختر القسم"}
            </option>
            {treatments.map((treatment) => (
              <option key={getTreatmentId(treatment)} value={getTreatmentId(treatment)}>
                {treatment.title}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-foreground">
            اختر العلاج
          </span>
          <select
            value={serviceIndex}
            onChange={(event) => setServiceIndex(event.target.value)}
            disabled={!selectedCategory}
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
            required
          >
            <option value="">اختر العلاج</option>
            {(selectedCategory?.services || []).map((service, index) => (
              <option key={`${service.title}-${index}`} value={String(index)}>
                {service.title}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-foreground">التاريخ</span>
          <input
            type="date"
            value={form.date}
            onChange={(event) => updateField("date", event.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            required
          />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium text-foreground">الساعة</span>
          <input
            type="time"
            value={form.time}
            onChange={(event) => updateField("time", event.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            required
          />
        </label>
      </div>

      {selectedService && (
        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 rounded-2xl border border-border bg-muted/30 p-4">
          <label className="space-y-2">
            <span className="text-sm font-medium text-foreground">
              نوع العلاج
            </span>
            <input
              value={selectedService.title || ""}
              readOnly
              className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground"
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-foreground">
              مدة الجلسة
            </span>
            <input
              value={selectedService.duration || ""}
              readOnly
              className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground"
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-foreground">السعر</span>
            <input
              value={selectedService.price || ""}
              readOnly
              className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground"
            />
          </label>

          {isHujama && (
            <label className="space-y-2">
              <span className="text-sm font-medium text-foreground">
                عدد الكاسات
              </span>
              <input
                value={selectedService.cupsCount || ""}
                readOnly
                className="w-full rounded-xl border border-border bg-background px-4 py-3 text-foreground"
              />
            </label>
          )}
        </div>
      )}

      <label className="mt-5 block space-y-2">
        <span className="text-sm font-medium text-foreground">ملاحظة</span>
        <textarea
          value={form.note}
          onChange={(event) => updateField("note", event.target.value)}
          rows={3}
          className="w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </label>

      {message && (
        <div
          className={`mt-5 rounded-xl px-4 py-3 text-sm ${
            messageType === "error"
              ? "bg-red-500/10 text-red-600"
              : messageType === "success"
                ? "bg-green-500/10 text-green-600"
                : "bg-primary/10 text-primary"
          }`}
        >
          {message}
        </div>
      )}

      <div className="mt-6 flex justify-end">
        <button
          type="submit"
          disabled={submitting || lookupLoading || loadingTreatments}
          className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "جارٍ حفظ الموعد..." : "حفظ الموعد"}
        </button>
      </div>
    </form>
  );
}
