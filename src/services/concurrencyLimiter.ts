export class ConcurrencyLimiter {

  private active = 0;


  constructor(
    private readonly limit:number
  ){}


  async run<T>(
    task:()=>Promise<T>
  ):Promise<T>{


    while(
      this.active >= this.limit
    ){

      await new Promise(
        resolve =>
          setTimeout(resolve,50)
      );

    }


    this.active++;


    try {

      return await task();

    } finally {

      this.active--;

    }

  }

}