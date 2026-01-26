import { User, Shield, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";

const AdminProfileCard = ({ onChangePassword }) => {
  return (
    <div className="card-elevated p-6 md:p-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
        {/* Avatar */}
        <div className="relative">
          <div className="w-20 h-20 md:w-24 md:h-24 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-lg">
            <User className="w-10 h-10 md:w-12 md:h-12 text-primary-foreground" />
          </div>
          <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-success flex items-center justify-center shadow-md">
            <Shield className="w-4 h-4 text-success-foreground" />
          </div>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <h2 className="text-2xl md:text-3xl font-bold text-foreground">
              مرحبًا,<br/> صقر دغش
            </h2>
            <span className="badge-role">مشرف</span>
          </div>
        </div>
        <Button
          onClick={onChangePassword}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl px-5 py-2.5 shadow-md"
        >
          <KeyRound className="w-4 h-4" />
         تغيير كلمة المرور
        </Button>
      </div>
    </div>
  );
};

export default AdminProfileCard;
