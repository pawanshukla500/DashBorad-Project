import MultiSeriesTrendChart from './MultiSeriesTrendChart';

/**
 * Return trend — customer vs courier lines + return rate %.
 */
export default function ReturnTrendChart({ data = [] }) {
  return (
    <MultiSeriesTrendChart
      data={data}
      series={['customerReturns', 'courierReturns', 'returnRate']}
      title="Return Trend"
      subtitle="Customer vs courier returns with return rate %"
      showHeaderStats={false}
    />
  );
}
