import EomClient from './EomClient';
import { format } from 'date-fns';
import { getEomTasks, createEomTasks } from '@/app/actions/tasks';

const tasksByGroup: any = {
  'In-Transit Report': [
    'Filter Master Tracker',
    'Pull shipment data',
  ],
  'Landed Costs': [
    'Duplicate last month LCT',
    'Enter landed costs',
  ],
};

export default async function EndOfMonthPage() {
  const currentMonth = format(new Date(), 'yyyy-MM');
  let tasks = [];

  try {
    const data = await getEomTasks(currentMonth);
    tasks = data || [];
    
    if (tasks.length === 0) {
      // Initialize tasks if none exist for current month
      const allTasks: any[] = [];
      Object.entries(tasksByGroup).forEach(([group, items]: any) => {
        items.forEach((title: string, i: number) => {
          allTasks.push({ month: currentMonth, group, title, status: 'Not Started', completed: false, order_index: i });
        });
      });
      await createEomTasks(allTasks);
      const newData = await getEomTasks(currentMonth);
      tasks = newData || [];
    }
  } catch {
    // render with empty tasks
  }

  return <EomClient initialTasks={tasks} currentMonth={currentMonth} />;
}
