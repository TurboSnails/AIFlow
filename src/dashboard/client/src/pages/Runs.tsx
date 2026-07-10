import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

interface Run {
  run_id: string;
  ts: string;
  status: string;
}

export function Runs() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ runs: Run[] }>("/api/runs")
      .then((data) => setRuns(data.runs))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      <h1>Runs</h1>
      <ul>
        {runs.map((run) => (
          <li key={run.run_id}>
            <Link to={`/runs/${run.run_id}`}>{run.run_id}</Link>
            {" "}
            <span>{run.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
