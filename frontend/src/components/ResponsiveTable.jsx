import { Grid, Table } from 'antd';

// An AntD Table that stops being a table on a phone. Below `md` every row is
// laid out as a small card — the first column as its heading, every other cell
// on its own line with the column title as a label — so nothing has to be
// scrolled sideways. The styling lives in index.css under `.table-stacked`;
// here each cell only gets the label it shows (`data-label`) and the heading
// cell its class. Selection checkboxes, expandable rows and pagination keep
// working unchanged; desktop gets the plain table, `scroll` included.
function stackColumns(columns) {
  let primaryTaken = false;
  return columns.map((col) => {
    const primary = !primaryTaken;
    primaryTaken = true;
    const label = typeof col.title === 'string' ? col.title : '';
    return {
      ...col,
      // A card has room to wrap, so let long names wrap instead of cutting them.
      ellipsis: false,
      onCell: (record, index) => {
        const own = col.onCell ? col.onCell(record, index) : {};
        return {
          ...own,
          'data-label': primary ? undefined : label || undefined,
          className: [own.className, primary ? 'stacked-primary' : ''].filter(Boolean).join(' '),
        };
      },
    };
  });
}

export default function ResponsiveTable({
  columns, className, scroll, stackBelow = 'md', ...rest
}) {
  const screens = Grid.useBreakpoint();
  // useBreakpoint is empty on the first render; treat that as desktop so the
  // table does not flash into cards on a wide screen.
  const stacked = screens[stackBelow] === false;
  if (!stacked) {
    return <Table columns={columns} className={className} scroll={scroll} {...rest} />;
  }
  return (
    <Table
      {...rest}
      columns={stackColumns(columns)}
      className={['table-stacked', className].filter(Boolean).join(' ')}
      tableLayout="auto"
    />
  );
}
