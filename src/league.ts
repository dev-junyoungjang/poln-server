import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

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

const TABLE_NAME = 'full-league';

function corsHeaders(origin?: string) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  };
}

function generateLeagueId(): string {
  // Generate a short, URL-friendly ID (6 characters)
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

interface Player {
  id: string;
  name: string;
  deck_name: string;
  wins: number;
  losses: number;
  draws: number;
}

interface Match {
  id: string;
  player1_id: string;
  player2_id: string;
  result: 'player1' | 'player2' | 'draw' | null;
}

interface LeagueData {
  players: Player[];
  current_round: number;
  total_rounds: number;
  matches: Match[][];
  game_started: boolean;
  round_in_progress: boolean;
}

// POST /api/league - Create a new league
export async function createLeague(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    const body: LeagueData = JSON.parse(event.body || '{}');
    const league_id = generateLeagueId();
    const start_at = new Date().toISOString();

    const item = {
      league_id,
      start_at,
      ...body,
      updated_at: start_at,
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );

    return {
      statusCode: 201,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ league_id, start_at }),
    };
  } catch (error) {
    console.error('Error creating league:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to create league' }),
    };
  }
}

// GET /api/league?id={league_id} - Get a league by ID
export async function getLeague(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    const league_id = event.queryStringParameters?.id;

    if (!league_id) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'league_id is required' }),
      };
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { league_id },
      })
    );

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'League not found' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify(result.Item),
    };
  } catch (error) {
    console.error('Error getting league:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to get league' }),
    };
  }
}

// PUT /api/league?id={league_id} - Update a league
export async function updateLeague(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    const league_id = event.queryStringParameters?.id;

    if (!league_id) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'league_id is required' }),
      };
    }

    const body: Partial<LeagueData> = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { league_id },
        UpdateExpression:
          'SET players = :players, current_round = :current_round, total_rounds = :total_rounds, matches = :matches, game_started = :game_started, round_in_progress = :round_in_progress, updated_at = :updated_at',
        ExpressionAttributeValues: {
          ':players': body.players,
          ':current_round': body.current_round,
          ':total_rounds': body.total_rounds,
          ':matches': body.matches,
          ':game_started': body.game_started,
          ':round_in_progress': body.round_in_progress,
          ':updated_at': now,
        },
      })
    );

    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    console.error('Error updating league:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to update league' }),
    };
  }
}
