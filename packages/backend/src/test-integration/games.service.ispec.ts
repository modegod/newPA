/**
 * Note: The following test cases are a full integration test of the backend
 * which includes complete MongoDB and Redis instances (not mocks).
 *
 * The tests should include concurrency tests for both MongoDb and Redis.
 *
 * The MongoDB instance is spun up using mongodb-memory-server.
 * The Redis instance is spun up via Docker Compose.
 *
 * One day we should probably also move MongoDB from mongodb-memory-server
 * to Docker Compose too.
 */

import { Test } from '@nestjs/testing';
import {
  INestApplication,
  HttpStatus,
  ValidationPipe,
  // Logger,
} from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { TypegooseModule } from 'nestjs-typegoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Redis from 'ioredis';
import { transformAndValidateSync } from '@proavalon/proto';
import {
  SocketEvents,
  LobbyRoomData,
  ChatResponse,
} from '@proavalon/proto/lobby';
import {
  CreateRoomDto,
  GameMode,
  RoomData,
  RoomState,
} from '@proavalon/proto/room';
// import * as util from 'util';

import { AuthController } from '../auth/auth.controller';
import { LocalStrategy } from '../auth/guards/local.strategy';
import { JwtStrategy } from '../auth/guards/jwt.strategy';
import { JWT_SECRET, JWT_EXPIRY } from '../util/getEnvVars';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { AllChatModule } from '../all-chat/all-chat.module';
import { RedisClientModule } from '../redis-client/redis-client.module';
import { GamesModule } from '../games/games.module';
import { RedisSocketIoAdapter } from '../util/redisSocketIoAdapter';

import {
  connectSocketHelper,
  socketEmit,
  socketOn,
  socketOnAll,
  socketCloseAll,
  socketNotOn,
} from './util/socket-promise';

// Allow extra time for mongodb-memory-server to download if needed
jest.setTimeout(600000);

// Mock redis port to match the redis-testing database
const REDIS_HOST = 'redis-testing';
const REDIS_PORT = 6379;

function mockEnvVars() {
  const original = require.requireActual('../util/getEnvVars');
  return {
    ...original, // Pass down all the original variables
    REDIS_HOST: 'redis-testing', // Duplicate definition: https://github.com/facebook/jest/issues/2567
    REDIS_PORT: 6379,
  };
}

jest.mock('../util/getEnvVars', () => mockEnvVars());

describe('GamesSocket', () => {
  let app1: INestApplication;
  let app2: INestApplication;
  let mongoServer: MongoMemoryServer;
  let jwtService: JwtService;
  let connectToSocketIO1: (token: string) => SocketIOClient.Socket;
  let connectToSocketIO2: (token: string) => SocketIOClient.Socket;
  let redis: Redis.Redis;

  const createApp = async (mongoUri: string) => {
    const moduleRef = await Test.createTestingModule({
      // mock dependencies that are coming from AuthModule
      imports: [
        PassportModule,
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: JWT_EXPIRY },
        }),
        TypegooseModule.forRoot(mongoUri, {
          useNewUrlParser: true,
          useUnifiedTopology: true,
        }),
        UsersModule,
        AuthModule,
        AllChatModule,
        RedisClientModule,
        GamesModule,
      ],
      controllers: [AuthController],
      providers: [LocalStrategy, JwtStrategy],
    }).compile();

    // eslint-disable-next-line no-param-reassign
    const app = moduleRef.createNestApplication(undefined, {});
    app.useGlobalPipes(new ValidationPipe());
    app.useWebSocketAdapter(new RedisSocketIoAdapter(app));

    jwtService = moduleRef.get<JwtService>(JwtService);

    // Uncomment this to see the logs in jest output.
    // app.useLogger(new Logger());

    await app.init();
    await app.listen(0);

    return app;
  };

  beforeEach(async () => {
    // Set up database
    mongoServer = new MongoMemoryServer();
    const mongoUri = await mongoServer.getUri();

    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    await redis.flushall();
    // await redis.monitor().then((monitor) => {
    //   monitor.on('monitor', (time, args, _source, _database) => {
    //     console.log(`${time}: ${util.inspect(args)}`);
    //   });
    // });

    // Set up two servers
    app1 = await createApp(mongoUri);
    app2 = await createApp(mongoUri);

    connectToSocketIO1 = connectSocketHelper(
      app1.getHttpServer().address().port,
    );
    connectToSocketIO2 = connectSocketHelper(
      app2.getHttpServer().address().port,
    );

    // Seed some starting users
    await request(app1.getHttpServer())
      .post('/auth/signup')
      .send({
        username: 'asdf',
        password: 'asdf',
        email: 'asdf@gmail.com',
      })
      .expect(HttpStatus.CREATED)
      .expect('Signed up username: asdf.');

    await request(app2.getHttpServer())
      .post('/auth/signup')
      .send({
        username: 'qwer',
        password: 'qwer',
        email: 'qwer@gmail.com',
      })
      .expect(HttpStatus.CREATED)
      .expect('Signed up username: qwer.');

    await request(app2.getHttpServer())
      .post('/auth/signup')
      .send({
        username: 'zxcv',
        password: 'zxcv',
        email: 'zxcv@gmail.com',
      })
      .expect(HttpStatus.CREATED)
      .expect('Signed up username: zxcv.');
  });

  afterEach(async () => {
    await redis.quit();
    await app1.close();
    await app2.close();
    await mongoServer.stop();
  });

  it('should be able to create rooms from two backend servers', async (done) => {
    const jwtToken1 = jwtService.sign({ username: 'asdf' });
    const jwtToken2 = jwtService.sign({ username: 'qwer' });

    const sockets = [
      connectToSocketIO1(jwtToken1),
      connectToSocketIO2(jwtToken2),
    ];

    sockets.forEach((socket) => socket.on('error', done));

    await Promise.all(socketOnAll(sockets, 'connect'));
    await Promise.all(socketOnAll(sockets, SocketEvents.AUTHORIZED));

    // Create some games concurrently and make sure it is successful.
    const settings: CreateRoomDto = {
      mode: GameMode.AVALON,
      joinPassword: undefined,
      maxNumPlayers: 10,
    };

    const data = transformAndValidateSync(CreateRoomDto, settings);

    const result1 = socketEmit(sockets[0], SocketEvents.CREATE_GAME, data);
    const result2 = socketEmit(sockets[0], SocketEvents.CREATE_GAME, data);

    // Should return the game id of the room, which is either 1 or 2
    // but not both the same.
    expect([1, 2]).toContain(await result1);
    expect([1, 2]).toContain(await result2);
    expect(await result1).not.toEqual(await result2);

    socketCloseAll(sockets, done);
  }, 5000);

  it('should be able to join, chat and leave in games', async (done) => {
    const jwtToken1 = jwtService.sign({ username: 'asdf' });
    const jwtToken2 = jwtService.sign({ username: 'qwer' });
    const jwtToken3 = jwtService.sign({ username: 'zxcv' });

    const sockets = [
      connectToSocketIO1(jwtToken1),
      connectToSocketIO2(jwtToken2),
      connectToSocketIO2(jwtToken3),
    ];

    sockets.forEach((socket) => socket.on('error', done));

    await Promise.all(socketOnAll(sockets, 'connect'));
    await Promise.all(socketOnAll(sockets, SocketEvents.AUTHORIZED));

    // Create a game
    const settings: CreateRoomDto = {
      mode: GameMode.AVALON,
      joinPassword: undefined,
      maxNumPlayers: 10,
    };

    const data = transformAndValidateSync(CreateRoomDto, settings);

    const gameId = await socketEmit(sockets[0], SocketEvents.CREATE_GAME, data);

    // Join the game
    expect(
      await socketEmit(sockets[0], SocketEvents.JOIN_GAME, {
        id: gameId,
      }),
    ).toEqual('OK');

    // Expect a join message from the other user
    const joinMsg = socketOn(sockets[0], SocketEvents.GAME_CHAT_TO_CLIENT);

    // Join the game on other user
    expect(
      await socketEmit(sockets[1], SocketEvents.JOIN_GAME, {
        id: gameId,
      }),
    ).toEqual('OK');

    // Test the join message is received
    expect(await joinMsg).toEqual(
      expect.objectContaining({
        text: 'qwer has joined the room.',
      }),
    );

    // Send a message in game room from any player
    // Everyone except sockets[2] (user: zxcv) should receive it
    socketNotOn(sockets[2], SocketEvents.GAME_CHAT_TO_CLIENT, done);
    sockets[0].emit(SocketEvents.GAME_CHAT_TO_SERVER, { text: 'hello world!' });

    const messages = await Promise.all(
      socketOnAll([sockets[0], sockets[1]], SocketEvents.GAME_CHAT_TO_CLIENT),
    );

    messages.forEach((msg) =>
      expect(msg).toEqual(
        expect.objectContaining({ text: 'hello world!', username: 'asdf' }),
      ),
    );

    // Leave the room
    // Person leaving shouldn't receive any messages
    socketNotOn(sockets[0], SocketEvents.GAME_CHAT_TO_CLIENT, done);
    // Person in room should see the leave message
    const leaveMsg = socketOn(sockets[1], SocketEvents.GAME_CHAT_TO_CLIENT);

    sockets[0].emit(SocketEvents.LEAVE_GAME, { id: gameId });

    expect(await leaveMsg).toEqual(
      expect.objectContaining({
        text: 'asdf has left the room.',
      }),
    );

    socketCloseAll(sockets, done);
  }, 5000);

  it('should receive lobby and on game create', async (done) => {
    const jwtToken1 = jwtService.sign({ username: 'asdf' });
    const jwtToken2 = jwtService.sign({ username: 'qwer' });

    const sockets = [
      connectToSocketIO1(jwtToken1),
      connectToSocketIO2(jwtToken2),
    ];

    sockets.forEach((socket) => socket.on('error', done));

    await Promise.all(socketOnAll(sockets, 'connect'));
    await Promise.all(socketOnAll(sockets, SocketEvents.AUTHORIZED));

    // Delay a bit for join messages to pass
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });

    // Create a game
    const settings: CreateRoomDto = {
      mode: GameMode.AVALON,
      joinPassword: undefined,
      maxNumPlayers: 10,
    };

    const data = transformAndValidateSync(CreateRoomDto, settings);

    {
      // Prepare to catch socket messages
      const promises = [
        ...socketOnAll(sockets, SocketEvents.UPDATE_LOBBY_GAMES),
        ...socketOnAll(sockets, SocketEvents.ALL_CHAT_TO_CLIENT),
      ];

      // Create a game
      const gameId = await socketEmit(
        sockets[0],
        SocketEvents.CREATE_GAME,
        data,
      );
      expect(gameId).toEqual(1);

      const res = await Promise.all(promises);

      const updateRoomMsgs = [res[0], res[1]] as LobbyRoomData[][];
      const gameCreatedMsgs = [res[2], res[3]] as ChatResponse[];

      for (const rooms of updateRoomMsgs) {
        expect(rooms[0].id).toEqual(gameId);
        expect(rooms[0].host).toEqual('asdf');
      }

      for (const msg of gameCreatedMsgs) {
        expect(msg.text).toEqual(`asdf has created room ${gameId}!`);
        expect(msg.username).toEqual('asdf');
      }
    }

    // Delay a bit
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });

    {
      // Prepare to catch socket messages
      const promises = [
        ...socketOnAll(sockets, SocketEvents.UPDATE_LOBBY_GAMES),
        ...socketOnAll(sockets, SocketEvents.ALL_CHAT_TO_CLIENT),
      ];

      // Create a game
      const gameId = await socketEmit(
        sockets[1],
        SocketEvents.CREATE_GAME,
        data,
      );
      expect(gameId).toEqual(2);

      const res = await Promise.all(promises);

      const updateRoomMsgs = [res[0], res[1]] as LobbyRoomData[][];
      const gameCreatedMsgs = [res[2], res[3]] as ChatResponse[];

      for (const rooms of updateRoomMsgs) {
        expect(rooms[0].id).toEqual(1);
        expect(rooms[0].host).toEqual('asdf');
        expect(rooms[1].id).toEqual(gameId);
        expect(rooms[1].host).toEqual('qwer');
      }

      for (const msg of gameCreatedMsgs) {
        expect(msg.text).toEqual(`qwer has created room ${gameId}!`);
        expect(msg.username).toEqual('qwer');
      }
    }

    socketCloseAll(sockets, done);
  }, 5000);

  it('should receive room data on joining a game', async (done) => {
    const jwtToken1 = jwtService.sign({ username: 'asdf' });
    const jwtToken2 = jwtService.sign({ username: 'qwer' });

    const sockets = [
      connectToSocketIO1(jwtToken1),
      connectToSocketIO2(jwtToken2),
    ];

    sockets.forEach((socket) => socket.on('error', done));

    await Promise.all(socketOnAll(sockets, 'connect'));
    await Promise.all(socketOnAll(sockets, SocketEvents.AUTHORIZED));

    // Delay a bit for join messages to pass
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });

    // Create a game
    const settings: CreateRoomDto = {
      mode: GameMode.AVALON,
      joinPassword: undefined,
      maxNumPlayers: 10,
    };

    const data = transformAndValidateSync(CreateRoomDto, settings);

    // Prepare to catch socket messages
    const promises = [
      ...socketOnAll(sockets, SocketEvents.UPDATE_LOBBY_GAMES),
      ...socketOnAll(sockets, SocketEvents.ALL_CHAT_TO_CLIENT),
    ];

    // Create a game
    const gameId = await socketEmit(sockets[0], SocketEvents.CREATE_GAME, data);
    expect(gameId).toEqual(1);

    // TODO Add in expect SocketEvents.UPDATE_ROOM for room creator.

    const res = await Promise.all(promises);

    const updateRoomMsgs = [res[0], res[1]] as LobbyRoomData[][];
    const gameCreatedMsgs = [res[2], res[3]] as ChatResponse[];

    for (const rooms of updateRoomMsgs) {
      expect(rooms[0].id).toEqual(gameId);
      expect(rooms[0].host).toEqual('asdf');
    }

    for (const msg of gameCreatedMsgs) {
      expect(msg.text).toEqual(`asdf has created room ${gameId}!`);
      expect(msg.username).toEqual('asdf');
    }

    // Delay a bit
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });

    // Join room on other socket
    const roomDataPromise = socketOn(sockets[1], SocketEvents.UPDATE_ROOM);

    expect(
      await socketEmit(sockets[1], SocketEvents.JOIN_GAME, {
        id: gameId,
      }),
    ).toEqual('OK');

    const roomData = (await roomDataPromise) as RoomData;

    expect(roomData.id).toEqual(1);
    expect(roomData.host).toEqual('asdf');
    expect(roomData.state).toEqual(RoomState.waiting);
    // TODO add spectator expectations?

    socketCloseAll(sockets, done);
  }, 5000);
});
