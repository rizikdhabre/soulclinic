import { Activity, Users, TrendingUp, Droplets } from "lucide-react";

const HujamahStatsCard = () => {
  return (
    <div className="card-elevated p-6">
      <h3 className="text-lg font-semibold mb-4">
        Hujamah Usage Overview
      </h3>

      <p className="text-4xl font-bold text-primary mb-6">2,419</p>

      <div className="grid grid-cols-3 gap-4">
        <div className="stat-box">
          <Activity />
          <p>Avg / Session</p>
          <strong>4.2</strong>
        </div>
        <div className="stat-box">
          <Users />
          <p>Total Sessions</p>
          <strong>576</strong>
        </div>
        <div className="stat-box">
          <TrendingUp />
          <p>Active Patients</p>
          <strong>184</strong>
        </div>
      </div>
    </div>
  );
};

export default HujamahStatsCard;
