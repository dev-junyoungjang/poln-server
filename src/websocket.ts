import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const isOffline = process.env.IS_OFFLINE === 'true';

const client = new DynamoDBClient(
  isOffline
    ? {
        region: 'localhost',
        endpoint: 'http://localhost:8000',
        credentials: {
          accessKeyId: 'localAccessKeyId',
          secretAccessKey: 'localSecretAccessKey',
        },
      }
    : {}
);
const docClient = DynamoDBDocumentClient.from(client);

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'league-connections';

interface TimerState {
  timerEndTime: number | null;
  timerRemainingSeconds: number;
  timerPresetMinutes: number;
  timerIsRunning: boolean;
}

// $connect - WebSocket connection established
export async function connect(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResult> {
  console.log('WebSocket connected:', event.requestContext.connectionId);
  return { statusCode: 200, body: 'Connected' };
}

// $disconnect - WebSocket connection closed
export async function disconnect(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId;
  console.log('WebSocket disconnected:', connectionId);

  try {
    // Find and delete the connection from all leagues
    // Since we don't know the leagueId, we need to scan or use a GSI
    // For simplicity, we'll query by connectionId using a scan (not ideal for large scale)
    // In production, consider adding a GSI on connectionId

    // For now, the connection will be cleaned up when we try to send to it and it fails
    // Or we can store connectionId -> leagueId mapping separately

    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error('Error on disconnect:', error);
    return { statusCode: 500, body: 'Disconnect error' };
  }
}

// joinLeague - Client joins a specific league room
export async function joinLeague(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId;

  try {
    const body = JSON.parse(event.body || '{}');
    const { leagueId, sessionId, isCreator } = body;

    if (!leagueId || !sessionId) {
      return { statusCode: 400, body: 'leagueId and sessionId are required' };
    }

    // Store connection in the connections table
    await docClient.send(
      new PutCommand({
        TableName: CONNECTIONS_TABLE,
        Item: {
          leagueId,
          connectionId,
          sessionId,
          isCreator: isCreator || false,
          connectedAt: new Date().toISOString(),
        },
      })
    );

    console.log(`Connection ${connectionId} joined league ${leagueId}`);
    return { statusCode: 200, body: 'Joined league' };
  } catch (error) {
    console.error('Error joining league:', error);
    return { statusCode: 500, body: 'Failed to join league' };
  }
}

// timerUpdate - Creator broadcasts timer state to all connections in the league
export async function timerUpdate(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResult> {
  const connectionId = event.requestContext.connectionId;
  const { domainName, stage } = event.requestContext;

  try {
    const body = JSON.parse(event.body || '{}');
    const { leagueId, timerState } = body as {
      leagueId: string;
      timerState: TimerState;
    };

    if (!leagueId || !timerState) {
      return { statusCode: 400, body: 'leagueId and timerState are required' };
    }

    // Get all connections for this league
    const result = await docClient.send(
      new QueryCommand({
        TableName: CONNECTIONS_TABLE,
        KeyConditionExpression: 'leagueId = :leagueId',
        ExpressionAttributeValues: {
          ':leagueId': leagueId,
        },
      })
    );

    const connections = result.Items || [];

    // Find the sender's connection to verify they're the creator
    const senderConnection = connections.find(
      (c) => c.connectionId === connectionId
    );

    if (!senderConnection?.isCreator) {
      return { statusCode: 403, body: 'Only the creator can update the timer' };
    }

    // Create API Gateway Management API client
    const apiGateway = new ApiGatewayManagementApiClient({
      endpoint: isOffline
        ? 'http://localhost:3001'
        : `https://${domainName}/${stage}`,
    });

    // Broadcast timer state to all connections in the league
    const message = JSON.stringify({
      type: 'timerUpdate',
      timerState,
    });

    const sendPromises = connections.map(async (connection) => {
      // Skip sending to the creator (they already have the state)
      if (connection.connectionId === connectionId) {
        return;
      }

      try {
        await apiGateway.send(
          new PostToConnectionCommand({
            ConnectionId: connection.connectionId,
            Data: Buffer.from(message),
          })
        );
      } catch (error: any) {
        // If connection is stale, remove it
        if (error.$metadata?.httpStatusCode === 410) {
          console.log(`Removing stale connection: ${connection.connectionId}`);
          await docClient.send(
            new DeleteCommand({
              TableName: CONNECTIONS_TABLE,
              Key: {
                leagueId,
                connectionId: connection.connectionId,
              },
            })
          );
        } else {
          console.error(
            `Error sending to ${connection.connectionId}:`,
            error
          );
        }
      }
    });

    await Promise.all(sendPromises);

    console.log(`Timer update broadcast to ${connections.length - 1} clients`);
    return { statusCode: 200, body: 'Timer update broadcast' };
  } catch (error) {
    console.error('Error broadcasting timer update:', error);
    return { statusCode: 500, body: 'Failed to broadcast timer update' };
  }
}