import { isValidPainRelief } from "@/lib/feedbackRating";

export default function PainReliefBadge({ value }) {
  if (!isValidPainRelief(value)) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
      <span>درجة التحسّن:</span><bdi dir="ltr">{value}/10</bdi>
    </span>
  );
}
