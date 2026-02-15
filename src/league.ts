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

const TABLE_NAME = 'full-league-table';

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
  // Timer and creator fields for shared timer sync
  creator_session_id?: string;
  timer_end_time?: number | null;
  timer_remaining_seconds?: number;
  timer_preset_minutes?: number;
  timer_is_running?: boolean;
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
      PK: `LEAGUE#${league_id}`,
      SK: `METADATA#${league_id}`,
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
        Key: { PK: `LEAGUE#${league_id}`, SK: `METADATA#${league_id}` },
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

    // Build update expression dynamically based on provided fields
    const updateParts: string[] = ['updated_at = :updated_at'];
    const expressionValues: Record<string, any> = { ':updated_at': now };

    if (body.players !== undefined) {
      updateParts.push('players = :players');
      expressionValues[':players'] = body.players;
    }
    if (body.current_round !== undefined) {
      updateParts.push('current_round = :current_round');
      expressionValues[':current_round'] = body.current_round;
    }
    if (body.total_rounds !== undefined) {
      updateParts.push('total_rounds = :total_rounds');
      expressionValues[':total_rounds'] = body.total_rounds;
    }
    if (body.matches !== undefined) {
      updateParts.push('matches = :matches');
      expressionValues[':matches'] = body.matches;
    }
    if (body.game_started !== undefined) {
      updateParts.push('game_started = :game_started');
      expressionValues[':game_started'] = body.game_started;
    }
    if (body.round_in_progress !== undefined) {
      updateParts.push('round_in_progress = :round_in_progress');
      expressionValues[':round_in_progress'] = body.round_in_progress;
    }
    // Timer fields
    if (body.creator_session_id !== undefined) {
      updateParts.push('creator_session_id = :creator_session_id');
      expressionValues[':creator_session_id'] = body.creator_session_id;
    }
    if (body.timer_end_time !== undefined) {
      updateParts.push('timer_end_time = :timer_end_time');
      expressionValues[':timer_end_time'] = body.timer_end_time;
    }
    if (body.timer_remaining_seconds !== undefined) {
      updateParts.push('timer_remaining_seconds = :timer_remaining_seconds');
      expressionValues[':timer_remaining_seconds'] = body.timer_remaining_seconds;
    }
    if (body.timer_preset_minutes !== undefined) {
      updateParts.push('timer_preset_minutes = :timer_preset_minutes');
      expressionValues[':timer_preset_minutes'] = body.timer_preset_minutes;
    }
    if (body.timer_is_running !== undefined) {
      updateParts.push('timer_is_running = :timer_is_running');
      expressionValues[':timer_is_running'] = body.timer_is_running;
    }

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `LEAGUE#${league_id}`, SK: `METADATA#${league_id}` },
        UpdateExpression: 'SET ' + updateParts.join(', '),
        ExpressionAttributeValues: expressionValues,
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
