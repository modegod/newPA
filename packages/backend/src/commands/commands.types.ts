import { SocketUser } from '../users/users.socket';

export interface Command {
  command: string;
  help: string;
  run: (socket: SocketUser, data: string[]) => Promise<void>;
}

export type Commands = Record<string, Command>;

export interface CommandsWrapper {
  commands: Commands;
}
