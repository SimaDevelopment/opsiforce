import type { Component } from 'solid-js';
import { ChartColumn, ChartLine, Package, Target } from '~/components/icons';

export interface Example {
  title: string;
  description: string;
  prompt: string;
  category: string;
  icon: Component<{ class?: string }>;
}

export const EXAMPLES: Example[] = [
  {
    title: 'Sales Dashboard',
    description: 'Interactive charts tracking revenue, deals, and monthly trends',
    prompt:
      'Build a sales analytics dashboard web app with interactive charts showing monthly revenue, deal pipeline, top products by revenue, and a comparison to the previous period. Use a clean, modern design with a sidebar nav.',
    category: 'dashboard',
    icon: ChartLine,
  },
  {
    title: 'KPI Tracker',
    description: 'Team metrics board with goal progress and trend indicators',
    prompt:
      'Create a KPI tracking web app where team members can add goals, log daily progress, and view trend charts. Show a summary dashboard with progress rings, sparkline charts, and a color-coded status for each metric.',
    category: 'dashboard',
    icon: Target,
  },
  {
    title: 'Analytics App',
    description: 'Real-time data visualization with filterable chart views',
    prompt:
      'Build a data analytics web app that takes a CSV or JSON data source, displays it as interactive bar, line, and pie charts, and lets users filter by date range and category. Include a summary stats row at the top.',
    category: 'app',
    icon: ChartColumn,
  },
  {
    title: 'Inventory Manager',
    description: 'Product catalog with stock levels, alerts, and a summary view',
    prompt:
      'Create an inventory management web app with a product table showing name, SKU, quantity, and status. Include add/edit/delete operations, low-stock highlighting, a search bar, and a dashboard showing total items, low stock count, and value.',
    category: 'app',
    icon: Package,
  },
];
