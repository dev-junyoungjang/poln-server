import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
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

const TABLE_NAME = 'tournament-players';
const SELECTED_TABLE_NAME = 'selected-tournament';

function corsHeaders(origin?: string) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

interface TournamentPlayer {
  number: string;
  name: string;
  score: number;
  tableNumber: number;
  opponent: string;
  opponentScore: number;
}

interface SaveRoundBody {
  tid: string;
  round: number;
  tournamentName: string;
  players: TournamentPlayer[];
}

// POST /api/tournament - Save tournament round data (idempotent)
export async function saveTournamentRound(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    const body: SaveRoundBody = JSON.parse(event.body || '{}');
    const { tid, round, tournamentName, players } = body;

    if (!tid || !round || !players?.length) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'tid, round, and players are required' }),
      };
    }

    const sk = `ROUND#${String(round).padStart(2, '0')}`;

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `TOURNAMENT#${tid}`,
          SK: sk,
          tid,
          round,
          tournament_name: tournamentName,
          players,
          created_at: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      })
    );

    return {
      statusCode: 201,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, created: true }),
    };
  } catch (error: any) {
    const origin = event.headers?.origin || event.headers?.Origin;

    if (error.name === 'ConditionalCheckFailedException') {
      return {
        statusCode: 200,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, created: false }),
      };
    }

    console.error('Error saving tournament round:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to save tournament round' }),
    };
  }
}

// GET /api/tournament/rounds?tid={tid}&round={round}
// Returns all saved round data (players array) for rounds 1..round
export async function getTournamentRounds(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    const tid = event.queryStringParameters?.tid;
    const roundStr = event.queryStringParameters?.round;

    if (!tid || !roundStr) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'tid and round are required' }),
      };
    }

    const requestedRound = parseInt(roundStr);
    const maxSK = `ROUND#${String(requestedRound).padStart(2, '0')}`;

    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :minSK AND :maxSK',
        ExpressionAttributeValues: {
          ':pk': `TOURNAMENT#${tid}`,
          ':minSK': 'ROUND#01',
          ':maxSK': maxSK,
        },
      })
    );

    const savedRounds = (result.Items || [])
      .map((item) => ({
        round: item.round as number,
        tournamentName: item.tournament_name as string,
        players: item.players as TournamentPlayer[],
      }))
      .sort((a, b) => a.round - b.round);

    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rounds: savedRounds }),
    };
  } catch (error) {
    console.error('Error fetching tournament rounds:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to fetch tournament rounds' }),
    };
  }
}

// GET /api/tournament/wld?tid={tid}&round={round}
export async function getTournamentWLD(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    const tid = event.queryStringParameters?.tid;
    const roundStr = event.queryStringParameters?.round;

    if (!tid || !roundStr) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'tid and round are required' }),
      };
    }

    const requestedRound = parseInt(roundStr);
    const maxSK = `ROUND#${String(requestedRound).padStart(2, '0')}`;

    // Query saved rounds from round 1 up to the requested round
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :minSK AND :maxSK',
        ExpressionAttributeValues: {
          ':pk': `TOURNAMENT#${tid}`,
          ':minSK': 'ROUND#01',
          ':maxSK': maxSK,
        },
      })
    );

    const savedRounds = result.Items || [];

    // Need at least 2 rounds to compute diffs (first round is baseline)
    if (savedRounds.length <= 1) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ players: {}, complete: false }),
      };
    }

    // Sort by round number
    savedRounds.sort((a, b) => (a.round as number) - (b.round as number));

    // Build player score map: playerNumber → { roundNumber: score }
    const playerScores: Record<string, Record<number, number>> = {};

    for (const roundData of savedRounds) {
      const roundNum = roundData.round as number;
      const players = roundData.players as TournamentPlayer[];

      for (const player of players) {
        if (!playerScores[player.number]) {
          playerScores[player.number] = {};
        }
        playerScores[player.number][roundNum] = player.score;
      }
    }

    // Compute W-L-D per player
    const wldMap: Record<string, { wins: number; losses: number; draws: number }> = {};
    const savedRoundNumbers = savedRounds.map((r) => r.round as number).sort((a, b) => a - b);

    // Check if we have all rounds from 1 to requestedRound
    const allRoundsPresent = savedRoundNumbers.length === requestedRound &&
      savedRoundNumbers.every((r, i) => r === i + 1);

    for (const [playerNumber, scores] of Object.entries(playerScores)) {
      let wins = 0;
      let losses = 0;
      let draws = 0;

      // Walk through consecutive saved rounds and diff scores
      // First round is baseline (scores before any games), diffs start from second round
      let prevScore: number | null = null;
      for (const roundNum of savedRoundNumbers) {
        const currentScore = scores[roundNum];
        if (currentScore === undefined) continue;

        if (prevScore === null) {
          // First saved round — just set baseline, no result to count
          prevScore = currentScore;
          continue;
        }

        const diff = currentScore - prevScore;

        if (diff === 3) wins++;
        else if (diff === 1) draws++;
        else if (diff === 0) losses++;
        else {
          // Multiple rounds gap — estimate using the diff
          const prevRoundIdx = savedRoundNumbers.indexOf(roundNum) - 1;
          const gapRounds = roundNum - savedRoundNumbers[prevRoundIdx];
          if (gapRounds === 1) {
            losses++;
          } else {
            const estWins = Math.floor(diff / 3);
            const estDraws = diff - 3 * estWins;
            const estLosses = gapRounds - estWins - estDraws;
            wins += Math.max(0, estWins);
            draws += Math.max(0, estDraws);
            losses += Math.max(0, estLosses);
          }
        }

        prevScore = currentScore;
      }

      wldMap[playerNumber] = { wins, losses, draws };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        players: wldMap,
        complete: allRoundsPresent,
        savedRounds: savedRoundNumbers,
      }),
    };
  } catch (error) {
    console.error('Error computing tournament WLD:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to compute WLD' }),
    };
  }
}

// GET /api/tournament/selected
export async function getSelectedTournament(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: SELECTED_TABLE_NAME,
        Key: { PK: 'CURRENT' },
      })
    );

    if (!result.Item?.tournamentId) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No selected tournament' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournamentId: result.Item.tournamentId,
        ...(result.Item.round != null && { round: result.Item.round }),
      }),
    };
  } catch (error) {
    console.error('Error fetching selected tournament:', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to fetch selected tournament' }),
    };
  }
}