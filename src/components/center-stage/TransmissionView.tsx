import { TransmissionSequence } from './TransmissionSequence';

interface TransmissionViewProps {
  message: string;
  onComplete: () => void;
}

export function TransmissionView({ message, onComplete }: TransmissionViewProps) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-4xl h-full max-h-[600px] relative">
        <div className="w-full h-full bg-black/80 border-2 border-primary/30 rounded-lg backdrop-blur-sm flex items-center justify-center overflow-hidden">
          {/* Corner accents */}
          <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-primary/30" />
          <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-primary/30" />

          <TransmissionSequence message={message} onComplete={onComplete} />
        </div>
      </div>
    </div>
  );
}
