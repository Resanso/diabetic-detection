import { useNavigate } from "react-router-dom";
import { TopBar } from "../components/ui";
import { PatientSearch } from "../components/PatientSearch";

export default function Patients() {
  const navigate = useNavigate();
  return (
    <>
      <TopBar title="Pasien" />
      <main className="page">
        <PatientSearch onPick={(p) => navigate(`/pasien/${p.id}`)} onNew={() => navigate("/pasien/baru")} />
      </main>
    </>
  );
}
