export interface BaseAgent {
    id: string;
    name: string;
    execute(input: any): Promise<any>;
  }