"use client";

import { useState } from "react";
import { FaWhatsapp, FaInstagram, FaPhoneAlt, FaMinus } from "react-icons/fa";

const WHATSAPP_URL = "https://wa.me/972532286019";
const INSTAGRAM_PERSONAL_URL = "https://www.instagram.com/sqr_dagash";
const INSTAGRAM_CLINIC_URL = "https://www.instagram.com/soul_clinica";
const PHONE_URL = "tel:+972532286019";

export default function ContactButtons() {
  const [open, setOpen] = useState(false);

  const handleWhatsAppClick = () => {
    if (!open) {
      setOpen(true);
    } else {
      window.open(WHATSAPP_URL, "_blank");
    }
  };

  return (
    <div className="fixed bottom-6 left-6 z-50 flex flex-col items-center gap-3">
      {/* Close button */}
      {open && (
        <button
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="
            bg-gray-700 hover:bg-gray-800
            text-white rounded-full
            p-2 shadow-md
            flex items-center justify-center
          "
        >
          <FaMinus size={14} />
        </button>
      )}

      {/* Phone */}
      {open && (
        <a
          href={PHONE_URL}
          aria-label="Call us"
          className="
            bg-blue-600 hover:bg-blue-700
            text-white rounded-full
            p-4 shadow-lg
            flex items-center justify-center
          "
        >
          <FaPhoneAlt size={20} />
        </a>
      )}

      {/* Instagram – Personal */}
      {open && (
        <div className="flex flex-col items-center">
          <a
            href={INSTAGRAM_PERSONAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Personal Instagram"
            className="
        bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600
        hover:opacity-90
        text-white rounded-full
        p-4 shadow-lg
        flex items-center justify-center
      "
          >
            <FaInstagram size={22} />
          </a>
          <span className="mt-1 text-[10px] text-gray-700 dark:text-gray-300">
            Personal
          </span>
        </div>
      )}

      {/* Instagram – Clinic */}
      {open && (
        <div className="flex flex-col items-center">
          <a
            href={INSTAGRAM_CLINIC_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Clinic Instagram"
            className="
        bg-gradient-to-tr from-purple-700 to-indigo-700
        hover:opacity-90
        text-white rounded-full
        p-4 shadow-lg
        flex items-center justify-center
      "
          >
            <FaInstagram size={22} />
          </a>
          <span className="mt-1 text-[10px] text-gray-700 dark:text-gray-300">
            Clinic
          </span>
        </div>
      )}

      {/* WhatsApp (Smart Button) */}
      <button
        onClick={handleWhatsAppClick}
        aria-label="WhatsApp"
        className="
          bg-green-500 hover:bg-green-600
          text-white rounded-full
          p-4 shadow-xl
          flex items-center justify-center
          hover:scale-105 transition-transform
        "
      >
        <FaWhatsapp size={26} />
      </button>
    </div>
  );
}
