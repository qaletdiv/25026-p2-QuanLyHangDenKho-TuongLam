'use client';

import React, { useState, useEffect } from 'react';
import { getEomTasks, updateEomTask, createEomTasks } from '../actions/tasks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, CheckCircle2, Circle, Clock } from 'lucide-react';
import { format } from 'date-fns';
import SopPanel from '@/components/layout/SopPanel';

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

const statusIcons: any = {
  'Not Started': <Circle className="w-4 h-4 text-muted-foreground" />,
  'In Progress': <Clock className="w-4 h-4 text-amber-500" />,
  'Done': <CheckCircle2 className="w-4 h-4 text-emerald-500" />,
};

const sopSections = [{title: 'Rules', content: <p>All must be completed</p>}];

export default function EndOfMonth() {
  const currentMonth = format(new Date(), 'yyyy-MM');
  const [sopOpen, setSopOpen] = useState(true);
  const [tasks, setTasks] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTasks = async () => {
    try {
      const data = await getEomTasks(currentMonth);
      setTasks(data || []);
      if (data && data.length === 0) {
        // Initialize tasks if none
        const allTasks: any[] = [];
        Object.entries(tasksByGroup).forEach(([group, items]: any) => {
          items.forEach((title: string, i: number) => {
            allTasks.push({ month: currentMonth, group, title, status: 'Not Started', order_index: i });
          });
        });
        await createEomTasks(allTasks);
        const newData = await getEomTasks(currentMonth);
        setTasks(newData || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'Done').length;
  const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800 font-medium">All EoM tasks must be completed.</p>
        </div>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-foreground">{format(new Date(), 'MMMM yyyy')} Progress</p>
              <p className="text-sm font-bold text-primary">{completedTasks}/{totalTasks}</p>
            </div>
            <Progress value={progress} className="h-2" />
          </CardContent>
        </Card>

        {Object.entries(tasksByGroup).map(([group]) => {
          const groupTasks = tasks.filter(t => t.group === group).sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
          const groupDone = groupTasks.filter(t => t.status === 'Done').length;
          return (
            <Card key={group}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">{group}</CardTitle>
                  <Badge variant="secondary" className="text-xs">{groupDone}/{groupTasks.length}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-1">
                {groupTasks.map(task => (
                  <div key={task.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group">
                    <button onClick={async () => {
                      const next = task.status === 'Not Started' ? 'In Progress' : task.status === 'In Progress' ? 'Done' : 'Not Started';
                      await updateEomTask(task.id, { status: next });
                      fetchTasks();
                    }}>
                      {statusIcons[task.status]}
                    </button>
                    <span className={`text-sm flex-1 ${task.status === 'Done' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                      {task.title}
                    </span>
                    <Select value={task.status} onValueChange={async (v: any) => {
                      await updateEomTask(task.id, { status: v });
                      fetchTasks();
                    }}>
                      <SelectTrigger className="w-28 h-7 text-xs opacity-0 group-hover:opacity-100 transition-opacity">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Not Started">Not Started</SelectItem>
                        <SelectItem value="In Progress">In Progress</SelectItem>
                        <SelectItem value="Done">Done</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
      <SopPanel title="EoM SOP" sections={sopSections} isOpen={sopOpen} onToggle={() => setSopOpen(!sopOpen)} />
    </div>
  );
}
