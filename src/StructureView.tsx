export type TableStructure = {
  columns: { name: string; dataType: string; nullable: boolean; defaultExpr: string | null }[];
  indexes: { name: string; definition: string; primary: boolean; unique: boolean }[];
  constraints: { name: string; kind: string; definition: string }[];
};

type Props = {
  table: string;
  structure: TableStructure;
  onBackToData: () => void;
};

export default function StructureView({ table, structure, onBackToData }: Props) {
  return (
    <div className="structure-view">
      <div className="structure-head">
        <span className="structure-title">{table}</span>
        <span className="spacer" />
        <button className="btn mini" onClick={onBackToData}>
          ← Data
        </button>
      </div>

      <div className="structure-section">Columns</div>
      <table className="structure-table">
        <thead>
          <tr>
            <th>name</th>
            <th>type</th>
            <th>nullable</th>
            <th>default</th>
          </tr>
        </thead>
        <tbody>
          {structure.columns.map((c) => (
            <tr key={c.name}>
              <td className="st-name">{c.name}</td>
              <td className="st-type">{c.dataType}</td>
              <td>{c.nullable ? "yes" : <b>not null</b>}</td>
              <td className="st-def">{c.defaultExpr ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="structure-section">Indexes</div>
      {structure.indexes.length === 0 && <div className="structure-empty">none</div>}
      {structure.indexes.map((i) => (
        <div key={i.name} className="structure-item">
          <span className="st-name">
            {i.name}
            {i.primary && <span className="st-badge">PK</span>}
            {i.unique && !i.primary && <span className="st-badge">unique</span>}
          </span>
          <div className="st-def">{i.definition}</div>
        </div>
      ))}

      <div className="structure-section">Constraints</div>
      {structure.constraints.length === 0 && <div className="structure-empty">none</div>}
      {structure.constraints.map((c) => (
        <div key={c.name} className="structure-item">
          <span className="st-name">
            {c.name}
            <span className="st-badge">{c.kind}</span>
          </span>
          <div className="st-def">{c.definition}</div>
        </div>
      ))}
    </div>
  );
}
