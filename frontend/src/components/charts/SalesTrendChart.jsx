import MultiSeriesTrendChart from './MultiSeriesTrendChart';

/**
 * Sales trend — modern multi-line (Sales / Bank / Orders).
 * Pillar bars hide comparisons across different scales; lines show trajectory clearly.
 */
export default function SalesTrendChart({ data = [] }) {
  return (
    <MultiSeriesTrendChart
      data={data}
      series={['revenue', 'bank', 'returns', 'orders']}
      title="Sales Trend"
      subtitle="Gross sales · bank received · returns · orders"
      showHeaderStats
      variant="bar"
    />
  );
}
