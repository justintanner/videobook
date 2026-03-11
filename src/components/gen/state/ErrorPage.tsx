import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ErrorPageProps {
  message?: string;
  className?: string;
}

export function ErrorPage({ message = 'No model options available', className }: ErrorPageProps) {
  return (
    <div className={cn('flex items-center justify-center h-full text-red-400', className)}>
      <AlertCircle className="w-6 h-6 mr-2" />
      {message}
    </div>
  );
}
