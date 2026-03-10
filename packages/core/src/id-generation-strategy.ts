export interface IdGenerationStrategy {
  next(sequence: number): string;
}

export class TimestampRandomIdStrategy implements IdGenerationStrategy {
  next(sequence: number): string {
    return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }
}
