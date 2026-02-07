import type { ReactNode } from "react";

export const metadata = {
  title: "Spreadsheet • Cravatta",
  description: "Catalogo articoli selezionati con link USFans e MuleBuy.",
};

export default function SpreadsheetLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
