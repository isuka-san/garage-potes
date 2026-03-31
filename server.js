const express = require("express");
const Database = require("better-sqlite3");
const { v4: uuidv4 } = require("uuid");
const ics = require("ics");
const path = require("path");

const app = express();
const db = new Database("garage.db");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Init DB
const schema = `
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cars (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    name TEXT NOT NULL,
    brand TEXT,
    model TEXT,
    year INTEGER,
    plate TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    duration_min INTEGER DEFAULT 60,
    color TEXT DEFAULT '#3B82F6'
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    car_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (car_id) REFERENCES cars(id),
    FOREIGN KEY (service_id) REFERENCES services(id)
  );
`;

db.exec(schema);

const seedServices = db.prepare("SELECT COUNT(*) as count FROM services").get();
if (seedServices.count === 0) {
  const insert = db.prepare("INSERT INTO services (id, name, description, duration_min, color) VALUES (?, ?, ?, ?, ?)");
  insert.run(uuidv4(), "Entretien", "Vidange, filtres, vérification générale", 90, "#22C55E");
  insert.run(uuidv4(), "Réparation", "Diagnostic et réparation mécanique", 120, "#EF4444");
  insert.run(uuidv4(), "Pneus", "Changement ou équilibrage pneus", 60, "#F59E0B");
  insert.run(uuidv4(), "Carrosserie / Peinture", "Retouche, peinture, pimpage", 180, "#8B5CF6");
  insert.run(uuidv4(), "Prépa piste", "Préparation et setup pour circuit", 240, "#EC4899");
  insert.run(uuidv4(), "Autre", "Autre intervention à préciser", 60, "#6B7280");
}

app.get("/api/members", (req, res) => {
  const members = db.prepare("SELECT * FROM members ORDER BY name").all();
  res.json(members);
});

app.post("/api/members", (req, res) => {
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ error: "Nom requis" });
  const id = uuidv4();
  db.prepare("INSERT INTO members (id, name, phone) VALUES (?, ?, ?)").run(id, name, phone || null);
  res.json({ id, name, phone });
});

app.get("/api/members/:memberId/cars", (req, res) => {
  const cars = db.prepare("SELECT * FROM cars WHERE member_id = ? ORDER BY name").all(req.params.memberId);
  res.json(cars);
});

app.post("/api/cars", (req, res) => {
  const { member_id, name, brand, model, year, plate, notes } = req.body;
  if (!member_id || !name) return res.status(400).json({ error: "Membre et nom requis" });
  const id = uuidv4();
  db.prepare("INSERT INTO cars (id, member_id, name, brand, model, year, plate, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, member_id, name, brand || null, model || null, year || null, plate || null, notes || null);
  res.json({ id, member_id, name });
});

app.get("/api/services", (req, res) => {
  const services = db.prepare("SELECT * FROM services ORDER BY name").all();
  res.json(services);
});

app.get("/api/appointments", (req, res) => {
  const appointments = db.prepare(`
    SELECT a.*, m.name as member_name, c.name as car_name, c.brand, c.model, c.plate, s.name as service_name, s.color, s.duration_min
    FROM appointments a
    JOIN members m ON a.member_id = m.id
    JOIN cars c ON a.car_id = c.id
    JOIN services s ON a.service_id = s.id
    ORDER BY a.scheduled_at DESC
  `).all();
  res.json(appointments);
});

app.post("/api/appointments", (req, res) => {
  const { member_id, car_id, service_id, scheduled_at, notes } = req.body;
  if (!member_id || !car_id || !service_id || !scheduled_at)
    return res.status(400).json({ error: "Tous les champs sont requis" });
  const id = uuidv4();
  db.prepare("INSERT INTO appointments (id, member_id, car_id, service_id, scheduled_at, notes) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, member_id, car_id, service_id, scheduled_at, notes || null);
  res.json({ id, member_id, car_id, service_id, scheduled_at });
});

app.patch("/api/appointments/:id/status", (req, res) => {
  const { status } = req.body;
  const allowed = ["pending", "confirmed", "in_progress", "done", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Statut invalide" });
  db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/appointments/:id", (req, res) => {
  db.prepare("DELETE FROM appointments WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/appointments/:id/ics", (req, res) => {
  const appt = db.prepare(`
    SELECT a.*, m.name as member_name, m.phone, c.name as car_name, c.brand, c.model, c.plate, s.name as service_name, s.duration_min
    FROM appointments a
    JOIN members m ON a.member_id = m.id
    JOIN cars c ON a.car_id = c.id
    JOIN services s ON a.service_id = s.id
    WHERE a.id = ?
  `).get(req.params.id);

  if (!appt) return res.status(404).json({ error: "RDV introuvable" });

  const start = new Date(appt.scheduled_at);
  const event = {
    start: [start.getFullYear(), start.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes()],
    duration: { minutes: appt.duration_min },
    title: `🔧 ${appt.service_name} — ${appt.member_name}`,
    description: `Voiture : ${appt.car_name} (${appt.brand || ""} ${appt.model || ""} ${appt.plate ? "· " + appt.plate : ""})${appt.notes ? "\n\nNotes : " + appt.notes : ""}`,
    location: "Garage",
    status: "CONFIRMED",
    busyStatus: "BUSY",
    organizer: { name: "Garage des Potes" }
  };

  const { error, value } = ics.createEvent(event);
  if (error) return res.status(500).json({ error: "Erreur génération ICS" });

  res.setHeader("Content-Type", "text/calendar; charset=utf-8; method=REQUEST");
  res.setHeader("Content-Disposition", `inline; filename="rdv-${appt.id.slice(0, 8)}.ics"`);
  res.setHeader("Content-Transfer-Encoding", "quoted-printable");
  res.send(value);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Garage des Potes sur http://localhost:${PORT}`));
