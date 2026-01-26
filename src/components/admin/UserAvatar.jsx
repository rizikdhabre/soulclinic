import { cn } from "@/lib/utils";

const colors = [
  "bg-primary/10 text-primary",
  "bg-success/10 text-success",
  "bg-warning/10 text-warning",
  "bg-destructive/10 text-destructive",
];

export const UserAvatar = ({ firstName, lastName, size = "md" }) => {
  const initials = `${firstName[0]}${lastName[0]}`.toUpperCase();
  const color = colors[(firstName.charCodeAt(0) + lastName.charCodeAt(0)) % colors.length];

  const sizes = {
    sm: "w-8 h-8 text-xs",
    md: "w-10 h-10 text-sm",
    lg: "w-12 h-12 text-base",
  };

  return (
    <div className={cn("rounded-full flex items-center justify-center font-semibold", sizes[size], color)}>
      {initials}
    </div>
  );
};
