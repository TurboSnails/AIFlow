import { useEffect, useState } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { Runs } from "./pages/Runs";
import { Kanban } from "./pages/Kanban";
import { Debate } from "./pages/Debate";
import { Review } from "./pages/Review";
import { api, wsUrl } from "./api";

function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<object[]>([]);

  useEffect(() => {
    if (!id) return;
    api<{ events: object[] }>(`/api/runs/${id}`).then((data) => setEvents(data.events));
    const ws = new WebSocket(wsUrl());
    ws.onmessage = (msg) => {
      const { run_id, event } = JSON.parse(msg.data);
      if (run_id === id) {
        setEvents((prev) => [...prev, event]);
      }
    };
    return () => ws.close();
  }, [id]);

  return (
    <div>
      <h1>Run: {id}</h1>
      <nav>
        <Link to={`/runs/${id}/kanban`}>Kanban</Link>
        {" | "}
        <Link to={`/runs/${id}/debate`}>Debate</Link>
        {" | "}
        <Link to={`/runs/${id}/review`}>Review</Link>
      </nav>
      <pre>{JSON.stringify(events, null, 2)}</pre>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Runs />} />
      <Route path="/runs/:id" element={<RunDetail />} />
      <Route path="/runs/:id/kanban" element={<Kanban />} />
      <Route path="/runs/:id/debate" element={<Debate />} />
      <Route path="/runs/:id/review" element={<Review />} />
    </Routes>
  );
}
