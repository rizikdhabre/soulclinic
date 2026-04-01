const Error = () => {
  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div
        dir="rtl"
        className="w-full max-w-xl rounded-3xl border border-red-200/20 bg-white shadow-2xl overflow-hidden"
      >
        <div className="bg-gradient-to-r from-red-600 to-orange-500 px-6 py-4 text-white text-center">
          <h2 className="text-2xl md:text-3xl font-bold">تنبيه</h2>
        </div>

        <div className="px-6 py-8 text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <span className="text-3xl">⚠️</span>
          </div>

          <h3 className="text-2xl md:text-3xl font-extrabold text-gray-900 leading-relaxed mb-4">
            الموقع حالياً قيد الصيانة
          </h3>

          <p className="text-lg md:text-xl text-gray-700 leading-9 mb-3">
            الموقع غير متاح حالياً أو يتم العمل على إصلاحه.
          </p>

          <p className="text-base md:text-lg text-gray-500 leading-8">
            شكراً لصبركم وتفهمكم.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Error;