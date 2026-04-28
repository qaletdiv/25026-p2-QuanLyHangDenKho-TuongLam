const fs = require('fs');
const path = require('path');

const uiDir = path.join(__dirname, '../src/components/ui');
const layoutDir = path.join(__dirname, '../src/components/layout');

fs.mkdirSync(uiDir, { recursive: true });
fs.mkdirSync(layoutDir, { recursive: true });

const files = {
  'card.tsx': `export const Card = ({className, children, ...props}: any) => <div className={className} {...props}>{children}</div>;
export const CardHeader = ({className, children, ...props}: any) => <div className={className} {...props}>{children}</div>;
export const CardTitle = ({className, children, ...props}: any) => <h3 className={className} {...props}>{children}</h3>;
export const CardContent = ({className, children, ...props}: any) => <div className={className} {...props}>{children}</div>;`,
  'badge.tsx': `export const Badge = ({className, variant, children, ...props}: any) => <span className={className} {...props}>{children}</span>;`,
  'button.tsx': `export const Button = ({className, variant, size, children, ...props}: any) => <button className={className} {...props}>{children}</button>;`,
  'input.tsx': `export const Input = ({className, ...props}: any) => <input className={className} {...props} />;`,
  'select.tsx': `export const Select = ({children, value, onValueChange}: any) => <div onChange={(e:any) => onValueChange(e.target.value)}>{children}</div>;
export const SelectTrigger = ({className, children}: any) => <button className={className}>{children}</button>;
export const SelectValue = ({placeholder}: any) => <span>{placeholder}</span>;
export const SelectContent = ({children}: any) => <div>{children}</div>;
export const SelectItem = ({value, children}: any) => <div data-value={value}>{children}</div>;`,
  'table.tsx': `export const Table = ({className, children}: any) => <table className={className}>{children}</table>;
export const TableHeader = ({className, children}: any) => <thead className={className}>{children}</thead>;
export const TableBody = ({className, children}: any) => <tbody className={className}>{children}</tbody>;
export const TableRow = ({className, children, onClick}: any) => <tr className={className} onClick={onClick}>{children}</tr>;
export const TableHead = ({className, children, onClick}: any) => <th className={className} onClick={onClick}>{children}</th>;
export const TableCell = ({className, children, colSpan, onClick}: any) => <td className={className} colSpan={colSpan} onClick={onClick}>{children}</td>;`,
  'tabs.tsx': `export const Tabs = ({value, onValueChange, children}: any) => <div>{children}</div>;
export const TabsList = ({className, children}: any) => <div className={className}>{children}</div>;
export const TabsTrigger = ({value, className, children}: any) => <button className={className}>{children}</button>;
export const TabsContent = ({value, className, children}: any) => <div className={className}>{children}</div>;`,
  'label.tsx': `export const Label = ({className, children, htmlFor}: any) => <label className={className} htmlFor={htmlFor}>{children}</label>;`,
  'textarea.tsx': `export const Textarea = ({className, ...props}: any) => <textarea className={className} {...props} />;`,
  'radio-group.tsx': `export const RadioGroup = ({value, onValueChange, className, children}: any) => <div className={className}>{children}</div>;
export const RadioGroupItem = ({value, className}: any) => <input type="radio" value={value} className={className} />;`,
  'progress.tsx': `export const Progress = ({value, className}: any) => <div className={className}>{value}%</div>;`,
  'sheet.tsx': `export const Sheet = ({open, onOpenChange, children}: any) => open ? <div>{children}</div> : null;
export const SheetContent = ({className, children}: any) => <div className={className}>{children}</div>;
export const SheetHeader = ({children}: any) => <div>{children}</div>;
export const SheetTitle = ({className, children}: any) => <h2 className={className}>{children}</h2>;`,
  'separator.tsx': `export const Separator = () => <hr />;`,
  'switch.tsx': `export const Switch = ({checked, onCheckedChange, id}: any) => <input type="checkbox" id={id} checked={checked} onChange={(e)=>onCheckedChange(e.target.checked)} />;`,
};

for (const [filename, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(uiDir, filename), content);
}

const layoutFiles = {
  'AppLayout.tsx': `export default function AppLayout({children}: any) { return <div className="app-layout">{children}</div>; }`,
  'SopPanel.tsx': `export default function SopPanel({title, sections, isOpen, onToggle}: any) { return <div className="sop-panel">SOP Panel Placeholder</div>; }`
};

for (const [filename, content] of Object.entries(layoutFiles)) {
  fs.writeFileSync(path.join(layoutDir, filename), content);
}

console.log('UI stubs created successfully');
