import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import axios from 'axios';

const BASE_URL = 'https://tcg.sfc-jpn.jp';

function buildCookie(tid: string): string {
  return `TCG${tid}=ShikibetsuNo=0&Visitor=`;
}

function corsHeaders(origin?: string) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

export async function proxy(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: '',
    };
  }

  try {
    const { tid, round = '1', page = '1', sort = 'Score' } = event.queryStringParameters || {};

    if (!tid) {
      return {
        statusCode: 400,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ error: 'tid is required' }),
      };
    }

    const url = `${BASE_URL}/tour.asp?tid=${tid}&kno=${round}&blk=&Page=${page}&Sort=${sort}&Order=&Extract=&znt=0&flu=&Exclusive=0`;
    const cookie = buildCookie(tid);

    const response = await axios.get(url, {
      headers: {
        Cookie: cookie,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      },
      responseType: 'text',
    });

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': 'text/html; charset=utf-8',
      },
      body: response.data,
    };
  } catch (error) {
    console.error('Error proxying request:', error);
    return {
      statusCode: 500,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: 'Failed to fetch data' }),
    };
  }
}
