import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="text-center">
        <h1 className="mb-4 text-6xl font-serif font-bold text-foreground">
          404
        </h1>

        <p className="mb-6 text-xl text-muted-foreground">
          الصفحة غير موجودة أو لم تعد متاحة.
        </p>

        <Link
          href="/"
          className="text-primary underline underline-offset-4 hover:text-primary/90"
        >
          العودة إلى الرئيسية
        </Link>
      </div>
    </div>
  );
}
