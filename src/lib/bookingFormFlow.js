function emptySnapshot(submitting = false) {
  return {
    hasPendingBooking: false,
    profileStatus: null,
    submitting,
  };
}

export function createBookingFormFlow() {
  let pendingBookingPayload = null;
  let profileStatus = null;
  let submitting = false;
  let version = 0;

  function getSnapshot() {
    if (!pendingBookingPayload) return emptySnapshot(submitting);

    return {
      hasPendingBooking: true,
      profileStatus,
      submitting,
    };
  }

  function clearPendingBooking() {
    version += 1;
    pendingBookingPayload = null;
    profileStatus = null;
  }

  function acceptCompletion({ completion, bookingData, normalizedPhone }) {
    if (submitting || pendingBookingPayload) return { status: "pending" };

    const verificationToken = completion?.verificationToken;
    if (
      completion?.purpose !== "booking" ||
      typeof verificationToken !== "string" ||
      !verificationToken ||
      !normalizedPhone
    ) {
      return { status: "invalid" };
    }

    version += 1;
    const profile = completion.profile;
    if (profile?.hasCompleteName) {
      if (
        typeof profile.firstName !== "string" ||
        !profile.firstName.trim() ||
        typeof profile.lastName !== "string" ||
        !profile.lastName.trim()
      ) {
        return { status: "invalid" };
      }

      pendingBookingPayload = {
        ...(bookingData ?? {}),
        phone: normalizedPhone,
        firstName: profile.firstName,
        lastName: profile.lastName,
        verificationToken,
      };
      profileStatus = "complete";
      return { status: "complete" };
    }

    pendingBookingPayload = {
      ...(bookingData ?? {}),
      phone: normalizedPhone,
      firstName: "",
      lastName: "",
      verificationToken,
    };
    profileStatus = "incomplete";
    return { status: "details" };
  }

  async function submit({ onSubmit, details } = {}) {
    if (submitting) return { status: "busy" };
    if (!pendingBookingPayload) return { status: "missing" };

    if (profileStatus === "incomplete" && details) {
      const firstName = String(details.firstName || "").trim();
      const lastName = String(details.lastName || "").trim();
      if (!firstName || !lastName) return { status: "invalid-details" };

      pendingBookingPayload = {
        ...pendingBookingPayload,
        firstName,
        lastName,
      };
    }

    if (
      profileStatus === "incomplete" &&
      (!pendingBookingPayload.firstName || !pendingBookingPayload.lastName)
    ) {
      return { status: "invalid-details" };
    }

    const submissionVersion = version;
    const payload = { ...pendingBookingPayload };
    submitting = true;

    try {
      const result = await onSubmit(payload);
      if (submissionVersion !== version) return { status: "cancelled" };
      if (result === false) {
        return { status: "retry", reason: "rejected" };
      }

      clearPendingBooking();
      return { status: "success" };
    } catch {
      if (submissionVersion !== version) return { status: "cancelled" };
      return { status: "retry", reason: "error" };
    } finally {
      submitting = false;
    }
  }

  return {
    acceptCompletion,
    getSnapshot,
    phoneChanged: clearPendingBooking,
    reset: clearPendingBooking,
    submit,
  };
}
